#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { TqsftNatInstanceStack } from '../lib/tqsft-nat-instance-stack';

const app = new cdk.App();
new TqsftNatInstanceStack(app, 'TqsftNatInstanceStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});