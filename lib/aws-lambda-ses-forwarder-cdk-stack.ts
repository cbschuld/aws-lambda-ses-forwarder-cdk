import {
  Stack,
  StackProps,
  Duration,
  CfnOutput,
  aws_s3 as s3,
  aws_lambda as lambda,
  aws_route53 as route53,
  aws_ses as ses,
  aws_iam as iam
} from 'aws-cdk-lib'
import { Construct } from 'constructs'
import * as path from 'path'
import * as actions from 'aws-cdk-lib/aws-ses-actions'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'
import config from '../src/config.json'
import { VerifySesDomain, VerifySesEmailAddress } from '@seeebiii/ses-verify-identities'

export class AwsLambdaSesForwarderCdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    const domainName = this.node.tryGetContext('domain')
    const bucketName = `ses-forwarder-${domainName.replace('.', '-')}`

    const forwarder = new NodejsFunction(this, 'forwarder', {
      runtime: lambda.Runtime.NODEJS_LATEST, // Updated runtime
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(30),
      handler: 'handler',
      entry: path.join(__dirname, '../src/forwarder.ts'),
      environment: {
        REGION: Stack.of(this).region,
        AVAILABILITY_ZONES: JSON.stringify(Stack.of(this).availabilityZones),
        DOMAIN: domainName,
        BUCKET: bucketName
      }
    })

    forwarder.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [`arn:aws:ses:${Stack.of(this).region}:${Stack.of(this).account}:identity/*`]
      })
    )

    const s3Bucket = new s3.Bucket(this, 'S3SesForwarder', {
      bucketName,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL
    })
    s3Bucket.grantReadWrite(forwarder)

    new VerifySesDomain(this, 'SesDomainVerification', { domainName })

    const emails: string[] = Object.values(config.forwardMapping).flat()
    emails.forEach((emailAddress, index) => {
      new VerifySesEmailAddress(this, `SesEmailVerification${index}`, { emailAddress })
    })

    const hostedZone = route53.HostedZone.fromLookup(this, 'DomainHostedZone', {
      domainName
    })

    const receiptRuleSetName = `SesForwarderRuleSet-${domainName.replace('.', '-')}`

    new CfnOutput(this, 'SESRuleSetName', {
      value: receiptRuleSetName,
      exportName: 'SESRuleSetName'
    })

    new ses.ReceiptRuleSet(this, 'RuleSet', {
      receiptRuleSetName,
      rules: [
        {
          enabled: true,
          recipients: [domainName],
          scanEnabled: true,
          actions: [
            new actions.AddHeader({
              name: 'X-SES-Forwarded-From',
              value: domainName
            }),
            new actions.S3({
              bucket: s3Bucket
            }),
            new actions.Lambda({ function: forwarder })
          ]
        }
      ]
    })

    new route53.MxRecord(this, 'MxRecord', {
      values: [
        {
          hostName: `inbound-smtp.${Stack.of(this).region}.amazonaws.com`,
          priority: 10
        }
      ],
      zone: hostedZone,
      ttl: Duration.minutes(30)
    })
  }
}
