#!/usr/bin/env node
import 'source-map-support/register'
import { App } from 'aws-cdk-lib'
import { AwsLambdaSesForwarderCdkStack } from '../lib/aws-lambda-ses-forwarder-cdk-stack'

const app = new App()

let region = app.node.tryGetContext('region')
if (!region || typeof region !== 'string' || region.trim() === '') {
  region = 'us-west-2'
}

const account = app.node.tryGetContext('account')
if (!account || typeof account !== 'string' || account.trim() === '') {
  throw new Error("Must pass a '-c account=<MY_AWS_ACCOUNT_NUMBER>' context parameter")
}

const domain = app.node.tryGetContext('domain')
if (!domain || typeof domain !== 'string' || domain.trim() === '') {
  throw new Error("Must pass a '-c domain=<DOMAIN>' context parameter")
}

new AwsLambdaSesForwarderCdkStack(app, 'AwsLambdaSesForwarderCdkStack', {
  env: { account, region }
})
