'use strict'

import { S3, SES } from 'aws-sdk'
import { SESEvent, SESHandler, SESMessage } from 'aws-lambda'
import assert from 'assert'
import config from '../config.json'
import Log from 'lambda-tree'

interface ForwarderConfig {
  fromEmail: string
  subjectPrefix: string
  emailKeyPrefix: string
  forwardMapping: { [key: string]: string[] }
  allowPlusSign: boolean
}

const CONFIG: ForwarderConfig = {
  ...{
    fromEmail: 'noreply@example.com',
    subjectPrefix: '',
    emailKeyPrefix: '',
    allowPlusSign: true,
    forwardMapping: {}
  },
  ...config
}

const s3 = new S3()
const ses = new SES()
const log = new Log()

/**
 * Send email using the SES sendRawEmail command.
 *
 * @param {string} originalRecipient - original email recipient
 * @param {string[]} originalRecipients - list of original email recipients
 * @param {string[]} updatedRecipients - list of updated email recipients
 * @param {string} messageBody - the message body
 *
 * @return {boolean} - Promise resolved with data.
 */
const sendMessage = async (
  originalRecipient: string,
  originalRecipients: string[],
  updatedRecipients: string[],
  messageBody: string
): Promise<boolean> => {
  var params = {
    Destinations: updatedRecipients,
    Source: originalRecipient,
    RawMessage: {
      Data: messageBody
    }
  }
  log.info(
    `sendMessage: Sending email via SES. Original recipients: ${originalRecipients.join(
      ', '
    )}. Transformed recipients: ${updatedRecipients.join(', ')}.`
  )
  return new Promise(function (resolve, reject) {
    ses.sendRawEmail(params, function (err, result) {
      if (err) {
        log.error('sendRawEmail() returned error.', {
          error: err,
          stack: err.stack
        })
        return reject(new Error('Error: Email sending failed.'))
      }
      log.info('sendRawEmail() successful.', { result: result })
      resolve(true)
    })
  })
}

/**
 * Processes the message data, making updates to recipients and other headers
 * before returning the updated message.
 *
 * @param {string} originalRecipient - the original recipient
 * @param {string} messageBody - the message body
 * @return {string} - the translated message body
 */
const processMessage = (originalRecipient: string, messageBody: string): string => {
  var match = messageBody.match(/^((?:.+\r?\n)*)(\r?\n(?:.*\s+)*)/m)
  var header = match && match[1] ? match[1] : messageBody
  var body = match && match[2] ? match[2] : ''

  // Add "Reply-To:" with the "From" address if it doesn't already exists
  if (!/^reply-to:[\t ]?/im.test(header)) {
    match = header.match(/^from:[\t ]?(.*(?:\r?\n\s+.*)*\r?\n)/im)
    var from = match && match[1] ? match[1] : ''
    if (from) {
      header = header + 'Reply-To: ' + from
      log.info('Added Reply-To address of: ' + from)
    } else {
      log.info('Reply-To address not added because From address was not ' + 'properly extracted.')
    }
  }

  // SES does not allow sending messages from an unverified address,
  // so replace the message's "From:" header with the original
  // recipient (which is a verified domain)
  header = header.replace(/^from:[\t ]?(.*(?:\r?\n\s+.*)*)/gim, function (_match, from) {
    var fromText
    if (CONFIG.fromEmail) {
      fromText = 'From: ' + from.replace(/<(.*)>/, '').trim() + ' <' + CONFIG.fromEmail + '>'
    } else {
      fromText = 'From: ' + from.replace('<', 'at ').replace('>', '') + ' <' + originalRecipient + '>'
    }
    return fromText
  })

  // Add a prefix to the Subject
  if (CONFIG.subjectPrefix) {
    header = header.replace(/^subject:[\t ]?(.*)/gim, function (match, subject) {
      return 'Subject: ' + CONFIG.subjectPrefix + subject
    })
  }

  // Remove the Return-Path header.
  header = header.replace(/^return-path:[\t ]?(.*)\r?\n/gim, '')

  // Remove Sender header.
  header = header.replace(/^sender:[\t ]?(.*)\r?\n/gim, '')

  // Remove Message-ID header.
  header = header.replace(/^message-id:[\t ]?(.*)\r?\n/gim, '')

  // Remove all DKIM-Signature headers to prevent triggering an
  // "InvalidParameterValue: Duplicate header 'DKIM-Signature'" error.
  // These signatures will likely be invalid anyways, since the From
  // header was modified.
  header = header.replace(/^dkim-signature:[\t ]?.*\r?\n(\s+.*\r?\n)*/gim, '')

  return header + body
}

/**
 * Fetches the message data from S3.
 * @param {object} message - the SESMessage object
 * @return {string|null} - message content
 */
const fetchMessage = async (message: SESMessage): Promise<string | null> => {
  log.info('Fetching email at s3://' + process.env.BUCKET + '/' + CONFIG.emailKeyPrefix + message.mail.messageId)
  const Bucket = process.env.BUCKET || ''
  assert(Bucket, 'Bucket is not defined')
  return s3
    .getObject({
      Bucket,
      Key: `${CONFIG.emailKeyPrefix}${message.mail.messageId}`
    })
    .promise()
    .then((data) => {
      return data.Body?.toString() ?? null
    })
    .catch((err) => {
      log.error('getObject() returned error:', {
        error: err,
        stack: err.stack
      })
      return null
    })
}

interface RecipientsResult {
  original: string
  recipients: string[]
}

/**
 * Transforms the original recipients to the desired forwarded destinations.
 *
 * @param {SESMessage} message - the SESMessage object
 *
 * @return {RecipientsResult} - Recipient payload with original recipients and desired recipients.
 */
const transformRecipients = (message: SESMessage): RecipientsResult => {
  var newRecipients: string[] = []
  let original = ''

  const originalRecipients = message.receipt.recipients
  originalRecipients.forEach((origEmail) => {
    var origEmailKey = origEmail.toLowerCase()
    if (CONFIG.allowPlusSign) {
      origEmailKey = origEmailKey.replace(/\+.*?@/, '@')
    }
    if (CONFIG.forwardMapping.hasOwnProperty(origEmailKey)) {
      newRecipients = newRecipients.concat(CONFIG.forwardMapping[origEmailKey])
      original = origEmail
    } else {
      var origEmailDomain
      var origEmailUser
      var pos = origEmailKey.lastIndexOf('@')
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
    log.info(
      'Finishing process. No new recipients found for ' + 'original destinations: ' + originalRecipients.join(', ')
    )
    return { original, recipients: originalRecipients }
  }
  return { original, recipients: newRecipients }
}

/**
 * Parses the SES event record provided for the `mail` and `recipients` data.
 *
 * @param {SESEvent} event - SES event record
 * @return {SESMessage} - Promise resolved with an SESMessage.
 */
const parseEvent = (event: SESEvent): Promise<SESMessage> => {
  if (
    !event ||
    !event.hasOwnProperty('Records') ||
    event.Records.length !== 1 ||
    !event.Records[0].hasOwnProperty('eventSource') ||
    event.Records[0].eventSource !== 'aws:ses' ||
    event.Records[0].eventVersion !== '1.0'
  ) {
    log.info('parseEvent() received invalid SES message:', {
      level: 'error',
      event: JSON.stringify(event)
    })
    return Promise.reject(new Error('Error: Received invalid SES message.'))
  }
  return Promise.resolve(event.Records[0].ses)
}

export const handler: SESHandler = async (event) => {
  log.info('[event]', event)
  log.info('[event.Records[0]]', event.Records[0])
  log.info('[event.Records[0].ses]', event.Records[0].ses)
  log.info('[event.Records[0].ses.receipt]', event.Records[0].ses.receipt)

  return parseEvent(event)
    .then(async (message) => {
      log.info('[message]', message)
      const { original, recipients } = transformRecipients(message)
      log.info('[original]', original)
      log.info('[recipients]', recipients)
      return fetchMessage(message)
        .then(async (messageBody) => {
          log.info('[messageBody]', messageBody)
          assert(messageBody, 'Message body is not defined')
          const updatedMessageBody = processMessage(original, messageBody || '')
          return sendMessage(original, message.receipt.recipients, recipients, updatedMessageBody)
            .then((success) => {
              log.info('[sendMessage]', success)
            })
            .catch((err) => {
              log.error('[sendMessage]', err)
            })
        })
        .catch((err) => {
          log.error('[fetchMessage]', err)
        })
    })
    .catch((err) => {
      log.error('[parseEvent]', { err })
    })
}
