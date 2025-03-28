import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'
import { SESClient, SendRawEmailCommand, SendRawEmailCommandInput } from '@aws-sdk/client-ses'
import { SESEvent, SESHandler, SESMessage, SESReceipt, SESReceiptStatus } from 'aws-lambda'
import assert from 'assert'
import config from './config.json'
import Log from 'lambda-tree'
import { Readable } from 'stream'

interface ForwarderConfig {
  fromEmail: string
  subjectPrefix: string
  emailKeyPrefix: string
  forwardMapping: { [key: string]: string[] }
  allowPlusSign: boolean
  rejectSpam: boolean
  discordWebhookUrl?: string
}

const CONFIG: ForwarderConfig = {
  ...{
    fromEmail: 'noreply@example.com',
    subjectPrefix: '',
    emailKeyPrefix: '',
    allowPlusSign: true,
    forwardMapping: {},
    rejectSpam: true
  },
  ...config
}

const s3 = new S3Client({})
const ses = new SESClient({})
const log = new Log<object>()

// Utility to convert ReadableStream to string
async function streamToString(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
  })
}

/**
 * Send email using the SES sendRawEmail command.
 */
const sendMessage = async (
  originalRecipient: string,
  originalRecipients: string[],
  updatedRecipients: string[],
  messageBody: string
): Promise<boolean> => {
  try {
    const params: SendRawEmailCommandInput = {
      Destinations: updatedRecipients, // e.g., ['cbschuld@gmail.com']
      Source: CONFIG.fromEmail, // Use verified SES identity, e.g., 'noreply@urlpinch.com'
      RawMessage: { Data: Buffer.from(messageBody) }
    }

    log.info({
      message: 'sendMessage: Sending email via SES.',
      originalRecipients: originalRecipients.join(', '),
      transformedRecipients: updatedRecipients.join(', ')
    })

    const result = await ses.send(new SendRawEmailCommand(params))
    log.info({
      message: 'sendRawEmail() successful.',
      result
    })
    return true
  } catch (err: any) {
    log.error({
      message: 'sendRawEmail() returned error.',
      error: err,
      stack: err.stack
    })
    throw new Error('Error: Email sending failed.')
  }
}

/**
 * Filters out SPAM emails.
 */
const filterSpam = async (message: SESMessage): Promise<boolean> => {
  const receipt = message.receipt
  if (CONFIG.rejectSpam && receipt) {
    const verdicts = ['spamVerdict', 'virusVerdict', 'spfVerdict', 'dkimVerdict', 'dmarcVerdict']
    for (const key of verdicts) {
      const verdict: SESReceiptStatus = receipt[key as keyof SESReceipt] as SESReceiptStatus
      if (verdict && verdict.status === 'FAIL') {
        log.error({
          message: 'Error: Email failed spam filter.',
          verdict: key
        })
        throw false
      }
    }
  }
  return true
}

/**
 * Processes the message data, updating headers before returning the updated message.
 */
const processMessage = (
  originalRecipient: string,
  messageBody: string,
  updatedRecipients: string[] // Added parameter for forwarded recipients
): string => {
  const match = messageBody.match(/^((?:.+\r?\n)*)(\r?\n(?:.*\s+)*)/m)
  let header = match && match[1] ? match[1] : messageBody
  let body = match && match[2] ? match[2] : ''

  // Split headers into an array for safer manipulation
  const headerLines = header.split(/\r?\n/).filter((line) => line.trim() !== '')
  const updatedHeaders: string[] = []

  let hasReplyTo = false
  let fromAddress = ''

  // Process headers line by line
  for (const line of headerLines) {
    if (/^reply-to:/i.test(line)) {
      hasReplyTo = true
      updatedHeaders.push(line)
    } else if (/^from:/i.test(line)) {
      fromAddress = line.replace(/^from:[\t ]?(.*)/i, '$1')
      if (CONFIG.fromEmail) {
        updatedHeaders.push(`From: ${fromAddress.replace(/<(.*)>/, '').trim()} <${CONFIG.fromEmail}>`)
      } else {
        updatedHeaders.push(`From: ${fromAddress.replace('<', 'at ').replace('>', '')} <${originalRecipient}>`)
      }
    } else if (/^to:/i.test(line)) {
      // Replace To header with forwarded recipients
      updatedHeaders.push(`To: ${updatedRecipients.join(', ')}`)
    } else if (/^subject:/i.test(line) && CONFIG.subjectPrefix) {
      updatedHeaders.push(line.replace(/^subject:[\t ]?(.*)/i, `Subject: ${CONFIG.subjectPrefix}$1`))
    } else if (!/^(return-path|sender|message-id|dkim-signature):/i.test(line)) {
      updatedHeaders.push(line) // Keep non-removed headers
    }
  }

  // Add Reply-To if missing
  if (!hasReplyTo && fromAddress) {
    updatedHeaders.push(`Reply-To: ${fromAddress}`)
    log.info({ message: 'Added Reply-To address', from: fromAddress })
  } else if (!hasReplyTo) {
    updatedHeaders.push(`Reply-To: ${originalRecipient}`)
    log.info({ message: 'Added default Reply-To', replyTo: originalRecipient })
  }

  // Add a footer to the body to clarify reply address
  body += `\r\n\r\n---\r\nForwarded by ${CONFIG.fromEmail}. Reply to: ${fromAddress || originalRecipient}`

  // Ensure proper email structure with a blank line between headers and body
  return updatedHeaders.join('\r\n') + '\r\n\r\n' + body
}

/**
 * Fetches the message data from S3.
 */
const fetchMessage = async (message: SESMessage): Promise<string | null> => {
  const Bucket = process.env.BUCKET || ''
  assert(Bucket, 'Bucket is not defined')
  const Key = `${CONFIG.emailKeyPrefix}${message.mail.messageId}`

  log.info({
    message: 'Fetching email from S3.',
    bucket: Bucket,
    key: Key
  })

  try {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket, Key }))
    if (!Body) throw new Error('No email body found in S3')

    return streamToString(Body as Readable)
  } catch (err: any) {
    log.error({
      message: 'getObject() returned error.',
      error: err,
      stack: err.stack
    })
    return null
  }
}

interface RecipientsResult {
  original: string
  recipients: string[]
}

/**
 * Transforms the original recipients to the desired forwarded destinations.
 */
const transformRecipients = (message: SESMessage): RecipientsResult => {
  let newRecipients: string[] = []
  let original = ''

  const originalRecipients = message.receipt.recipients
  originalRecipients.forEach((origEmail) => {
    let origEmailKey = origEmail.toLowerCase()
    if (CONFIG.allowPlusSign) {
      origEmailKey = origEmailKey.replace(/\+.*?@/, '@')
    }
    if (CONFIG.forwardMapping.hasOwnProperty(origEmailKey)) {
      newRecipients = newRecipients.concat(CONFIG.forwardMapping[origEmailKey])
      original = origEmail
    } else {
      let origEmailDomain: string | undefined
      let origEmailUser: string | undefined
      const pos = origEmailKey.lastIndexOf('@')
      if (pos === -1) {
        origEmailUser = origEmailKey
      } else {
        origEmailDomain = origEmailKey.slice(pos)
        origEmailUser = origEmailKey.slice(0, pos)
      }
      if (origEmailDomain && CONFIG.forwardMapping.hasOwnProperty(origEmailDomain)) {
        newRecipients = newRecipients.concat(CONFIG.forwardMapping[origEmailDomain])
        original = origEmail
      } else if (origEmailUser && CONFIG.forwardMapping.hasOwnProperty(origEmailUser)) {
        newRecipients = newRecipients.concat(CONFIG.forwardMapping[origEmailUser])
        original = origEmail
      } else if (CONFIG.forwardMapping.hasOwnProperty('@')) {
        newRecipients = newRecipients.concat(CONFIG.forwardMapping['@'])
        original = origEmail
      }
    }
  })

  if (!newRecipients.length) {
    log.info({
      message: 'Finishing process. No new recipients found.',
      originalDestinations: originalRecipients.join(', ')
    })
    return { original, recipients: originalRecipients }
  }
  return { original, recipients: newRecipients }
}

/**
 * Parses the SES event record provided for the mail and recipients data.
 */
const parseEvent = async (event: SESEvent): Promise<SESMessage> => {
  if (
    !event ||
    !event.Records ||
    event.Records.length !== 1 ||
    event.Records[0].eventSource !== 'aws:ses' ||
    event.Records[0].eventVersion !== '1.0'
  ) {
    log.error({
      message: 'parseEvent() received invalid SES message.',
      event
    })
    throw new Error('Error: Received invalid SES message.')
  }
  return event.Records[0].ses
}

/**
 * Send message to Discord using a webhook.
 */
async function sendDiscordMessage(content: string): Promise<void> {
  const webhookUrl = CONFIG.discordWebhookUrl ?? ''
  const payload = {
    content
  }

  if (webhookUrl.length > 0) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        throw new Error(`Discord webhook failed with status: ${response.status}`)
      }

      log.info({ message: 'Discord message sent successfully', content })
    } catch (err: any) {
      log.error({
        message: 'Failed to send Discord message',
        error: err.message,
        stack: err.stack
      })
      throw err // Optionally rethrow if you want the Lambda to fail on Discord errors
    }
  }
}

export const handler: SESHandler = async (event) => {
  try {
    const message = await parseEvent(event)

    // Send a Discord message with email details
    const discordMessage = `New email received!\nFrom: ${message?.mail?.commonHeaders?.from?.join(', ')}\nTo: ${message.receipt.recipients.join(', ')}\nSubject: ${message.mail.commonHeaders.subject}`
    await sendDiscordMessage(discordMessage)
    const { original, recipients } = transformRecipients(message)

    // Filter out spam/viruses if configured.
    await filterSpam(message)

    // Fetch the message from S3.
    const messageBody = await fetchMessage(message)
    assert(messageBody, 'Message body is not defined')

    // Update headers/From/Reply-To, passing updated recipients.
    const updatedMessageBody = processMessage(original, messageBody, recipients)

    log.info({ message: updatedMessageBody })

    // Send the transformed email.
    await sendMessage(original, message.receipt.recipients, recipients, updatedMessageBody)
    log.info({ message: 'Email forwarded successfully.' })
  } catch (err) {
    if (err === false) {
      log.info({ message: 'Email rejected by spam filter. No forwarding performed.' })
      return
    }
    log.error({
      message: 'Error in handler.',
      error: err
    })
  }
}
