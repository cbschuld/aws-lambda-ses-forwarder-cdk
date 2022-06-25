# SES Forwarding via CDK ✉️

The SES forwarding system allows you to have domain receive email via AWS SES and forward to another email account.

## Special Thanks

Special thanks to [Joe Turgeon](https://github.com/arithmetric) for doing the original lift here. This is an adapted version of his [SES Email Fowarder](https://github.com/arithmetric/aws-lambda-ses-forwarder) modified to TypeScript and then bootstrapped with the AWS CDK.

## Using for your domain

Actions to get SES Forwarding correctly on your domain:

- The first step is to make sure you have the [AWS CDK installed](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html)
- Clone or download this project
- Copy `src/config.sample.json` to `src/config.json` and update the file with parameters relative to your installation. _(the same parameter's as [Joe Turgeon](https://github.com/arithmetric) solution)_
- Deploy using the CDK _(see below for examples)_
- Enable the Ruleset _(the CDK does not allow this... read below how to do this quickly)(if this changes in the future I'll automate this)_

## config.json

Expected keys/values:

- **fromEmail**: Forwarded emails will come from this verified address
- **subjectPrefix**: Forwarded emails subject will contain this prefix
- **emailBucket**: S3 bucket name where SES stores emails.
- **rejectSpam**: Do not FWD email on which AWS detected as SPAM
- **emailKeyPrefix**: S3 key name prefix where SES stores email. Include the trailing slash.
- **allowPlusSign**: Enables support for plus sign suffixes on email addresses. If set to `true`, the username/mailbox part of an email address is parsed to remove anything after a plus sign. For example, an email sent to `example+test@example.com` would be treated as if it was sent to `example@example.com`.
- **forwardMapping**: Object where the key is the lowercase email address from which to forward and the value is an array of email addresses to which to send the message.

  To match all email addresses on a domain, use a key without the name part of an email address before the "at" symbol (i.e. `@example.com`).

  To match a mailbox name on all domains, use a key without the "at" symbol and domain part of an email address (i.e. `info`).

  To match all email addresses matching no other mapping, use "@" as a key.

## CDK Deploy

Deploy via the CDK using the CDK's cli. You will need to know your **AWS account ID**, the **region** you want to deploy the solution on and your receiving **domain**. You may need to add a named profile _(if you use them)_ or set your AWS keys up in the environment ([see the **Prerequisites** section of the CDK page](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html))

```sh
cdk deploy -c account=1234567890 -c domain=mydomain.com -c region=us-west-2

```

## Enable the Ruleset

You cannot activate an SES Ruleset from the CDK 👎 so...

To Enable:

```sh
RULESET=`aws cloudformation list-exports --query "Exports[?Name=='SESRuleSetName'].Value" --no-paginate --output text` \
 && \
aws ses set-active-receipt-rule-set --rule-set-name $RULESET
```

Or disable all of the Rulesets💥:

```sh
aws ses set-active-receipt-rule-set
```

## Rough downside of SES Forwarding

SES becomes the "real" sender of the email. If you smash SPAM on an email send to your account you will be hitting SPAM on yourself. Be smart and careful with your sending rating over at AWS SES.

## CDK Clean up

If you deploy the CDK in the wrong region and you want to clean it up you cannot simply do it. Thus, if you run `cdk bootstrap` in the wrong region there is no clean way to back out of it. The fastest way to clean it up is via:

```sh
aws cloudformation delete-stack --stack-name CDKToolkit
aws s3 ls | grep -i cdk
aws s3 rb --force s3://cdk-XXXX-assets-XXXXX-REGION
```

## Credits

Based on the work of [Joe Turgeon](https://github.com/arithmetric/aws-lambda-ses-forwarder) [@eleven41 and @mwhouser](https://github.com/eleven41/aws-lambda-send-ses-email)
