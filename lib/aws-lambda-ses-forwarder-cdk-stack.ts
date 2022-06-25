import { Stack, StackProps } from 'aws-cdk-lib'
import { Construct } from 'constructs'

import * as s3 from 'aws-cdk-lib/aws-s3'
import * as s3n from 'aws-cdk-lib/aws-s3-notifications'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as cdk from 'aws-cdk-lib'
import * as path from 'path'
import * as actions from 'aws-cdk-lib/aws-ses-actions'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as ses from 'aws-cdk-lib/aws-ses'
import * as iam from 'aws-cdk-lib/aws-iam'

import config from '../src/config.json'

import { VerifySesDomain, VerifySesEmailAddress } from '@seeebiii/ses-verify-identities'
import { assert } from 'console'
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs'

// https://github.com/seeebiii/ses-verify-identities

// Ruleset cannot be activated via CDK
// https://github.com/aws/aws-cdk/issues/10321
//
// enable with:
// aws ses set-active-receipt-rule-set --rule-set-name SesForwarderRuleSet-anticipated-io --profile=anticipated --region=us-west-2
//
// disable with:
// aws ses set-active-receipt-rule-set --profile=anticipated --region=us-west-2

//
//
//
//
export class AwsLambdaSesForwarderCdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props)

    const domainName = this.node.tryGetContext('domain')
    const bucketName = `ses-forwarder-${this.node.tryGetContext('domain').replace('.', '-')}`

    const forwarder = new NodejsFunction(this, 'forwarder', {
      runtime: lambda.Runtime.NODEJS_16_X,
      memorySize: 512, // size guidance https://github.com/arithmetric/aws-lambda-ses-forwarder
      timeout: cdk.Duration.seconds(30),
      handler: 'handler',
      //code: lambda.Code.fromAsset('src/', { exclude: ['*.ts'] }),
      entry: path.join(__dirname, '../src/forwarder.ts'),
      environment: {
        REGION: cdk.Stack.of(this).region,
        AVAILABILITY_ZONES: JSON.stringify(cdk.Stack.of(this).availabilityZones),
        DOMAIN: domainName,
        BUCKET: bucketName
      }
    })

    forwarder.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: [`arn:aws:ses:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:identity/*`]
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

    new cdk.CfnOutput(this, 'SESRuleSetName', {
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
          hostName: `inbound-smtp.${cdk.Stack.of(this).region}.amazonaws.com`,
          priority: 10
        }
      ],
      zone: hostedZone,
      ttl: cdk.Duration.minutes(30)
    })
  }
}
