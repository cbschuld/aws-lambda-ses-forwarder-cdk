#!/usr/bin/env node
import 'source-map-support/register'
import * as cdk from 'aws-cdk-lib'
import { AwsLambdaSesForwarderCdkStack } from '../lib/aws-lambda-ses-forwarder-cdk-stack'

const app = new cdk.App()

let region = app.node.tryGetContext('region')
if (region === undefined || !(typeof region === 'string') || region.trim() === '') {
  region = 'us-west-2'
}

const account = app.node.tryGetContext('account')
if (account === undefined || !(typeof account === 'string') || account.trim() === '') {
  throw new Error("Must pass a '-c account=<MY_AWS_ACCOUNT_NUMBER>' context parameter")
}

const domain = app.node.tryGetContext('domain')
if (domain === undefined || !(typeof domain === 'string') || domain.trim() === '') {
  throw new Error("Must pass a '-c domain=<DOMAIN>' context parameter")
}

new AwsLambdaSesForwarderCdkStack(app, 'AwsLambdaSesForwarderCdkStack', {
  /* If you don't specify 'env', this stack will be environment-agnostic.
   * Account/Region-dependent features and context lookups will not work,
   * but a single synthesized template can be deployed anywhere. */

  /* Uncomment the next line to specialize this stack for the AWS Account
   * and Region that are implied by the current CLI configuration. */
  // env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },

  /* Uncomment the next line if you know exactly what Account and Region you
   * want to deploy the stack to. */
  // env: { account: '123456789012', region: 'us-east-1' },

  /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */

  env: { account, region }
})
