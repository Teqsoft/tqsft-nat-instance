import * as cdk from 'aws-cdk-lib';
import { AutoScalingGroup, LifecycleTransition } from 'aws-cdk-lib/aws-autoscaling';
import { EbsDeviceVolumeType, InstanceClass, InstanceSize, InstanceType, KeyPair, LaunchTemplate, MachineImage, MultipartBody, MultipartUserData, OperatingSystemType, Peer, Port, SecurityGroup, SubnetType, UserData, Vpc, WindowsVersion } from 'aws-cdk-lib/aws-ec2';
import { Effect, ManagedPolicy, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';
import { readFileSync } from 'fs';
import path = require('path');
import { TopicHook } from 'aws-cdk-lib/aws-autoscaling-hooktargets';
import { LambdaSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class TqsftNatInstanceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpcCidr = cdk.Fn.importValue('Tqsft-VpcCidr');
    const isolatedRouteTables = cdk.Fn.importValue('Tqsft-IsolatedRouteTables');
    const keyPairName = new cdk.CfnParameter(this, 'KeyPairName', {
      type: "String",
      description: "Key Pair Name for SSH Access",

    })

    const vpcId = StringParameter.valueFromLookup(this, 'TqsftStack-VpcId');
    const vpc = Vpc.fromLookup(this, "vpc", {
      vpcId: vpcId
    });

    const cloudConfig = UserData.custom(readFileSync('src/cloud-config.txt','utf8'));
    const alterNAT = UserData.custom(readFileSync('src/alternat.sh', 'utf8').replace('${ROUTE_TABLES_IDS}',isolatedRouteTables));
    
    const multipartUserData = new MultipartUserData();
    multipartUserData.addPart(MultipartBody.fromUserData(cloudConfig, "text/cloud-config"));
    multipartUserData.addPart(MultipartBody.fromUserData(alterNAT, "text/x-shellscript"));

    const instanceRole = new Role(this, 'MyRole', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      roleName: "NatInstanceProfile"
    });
    instanceRole.addManagedPolicy({
      managedPolicyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
    })
    instanceRole.addToPolicy(new PolicyStatement({
      sid: 'alterNATInstancePermissions',
      effect: Effect.ALLOW,
      actions: [
        'ec2:ModifyInstanceAttribute'
      ],
      resources: [ '*' ]
    }));
    instanceRole.addToPolicy(new PolicyStatement({
      sid: 'alterNATInstanceRoute',
      effect: Effect.ALLOW,
      actions: [
        'ec2:DescribeRouteTables',
        'ec2:CreateRoute',
        'ec2:ReplaceRoute'
      ],
      resources: [ '*' ]
    }))

    const launchTemplateSG = new SecurityGroup(this, "LaunchTemplateSG", {
      vpc: vpc,
      securityGroupName: "LaunchTemplateSG"
    });

    launchTemplateSG.addIngressRule(
      Peer.ipv4(vpcCidr), 
      Port.allTraffic(), 
      "Ingress All Trafic in the subnet"
    )

    const keyPair = KeyPair.fromKeyPairName(this, "RaulRTKeyPair", keyPairName.valueAsString);

    const launchTemplate = new LaunchTemplate(this, "LaunchTemplate", {
      // requireImdsv2: true,
      role: instanceRole,
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.NANO),
      machineImage: MachineImage.fromSsmParameter(
          "/aws/service/canonical/ubuntu/server-minimal/22.04/stable/current/arm64/hvm/ebs-gp2/ami-id", {
            os: OperatingSystemType.LINUX,
            userData: multipartUserData
        }
      ),
      keyPair: keyPair,
      launchTemplateName: "NATInstancesLaunchTemplate",
      securityGroup: launchTemplateSG,
      
    });

    const natInstancesASG = new AutoScalingGroup(this, `nat-instances-asg`, {
      vpc: vpc,
      launchTemplate: launchTemplate,
      minCapacity: 0,
      maxCapacity: 1,
      vpcSubnets: {
        subnetType: SubnetType.PUBLIC
      },
      autoScalingGroupName: 'NatInstancesASG'
    });

    /**
     *  Lifecycle Hooks
     */

    // const lambdaExecutionRole = new Role(this, 'LambdaExecutionRole', {
    //   assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
    //   roleName: 'LambdaTerminationHookRole'
    // })

    // lambdaExecutionRole.addManagedPolicy({
    //   managedPolicyArn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole'
    // })

    // lambdaExecutionRole.addToPolicy(new PolicyStatement({
    //   effect: Effect.ALLOW,
    //   sid: '',
    //   actions: [
    //     "ec2:DescribeNatGateways",
    //     "ec2:DescribeRouteTables",
    //     "ec2:DescribeSubnets",
    //     "ec2:ReplaceRoute",
    //     "autoscaling:DescribeAutoScalingGroups"
    //   ],
    //   resources: [
    //     '*'
    //   ]
    // }));

    // const alternatLambdaTopic = new Topic(this, 'Topic', {
    //   topicName: 'AlternatatLambdaTopic',
    //   displayName: 'AlternatLambdaTopic'
    // });

    // const alternatTopicHook = new TopicHook(alternatLambdaTopic);

    // const alternatLambdaFunction = new Function(this, 'ShutdownEcsSvcsFunction', {
    //     functionName: 'ShutdownEcsSvcs',
    //     handler: "handler",
    //     runtime: Runtime.PYTHON_3_12,
    //     code: Code.fromAsset(path.join(__dirname, '../src/replace-route/app.py')),
    //     memorySize: 512,
    //     timeout: cdk.Duration.minutes(5),
    //     // initialPolicy: [ lambdaPolicy ],
    //     logRetention: RetentionDays.ONE_WEEK,
    //     role: lambdaExecutionRole
    // })

    // alternatLambdaTopic.addSubscription(new LambdaSubscription(alternatLambdaFunction));

    // natInstancesASG.addLifecycleHook('InstanceTerminatingHook', {
    //   lifecycleTransition: LifecycleTransition.INSTANCE_TERMINATING,
    //   lifecycleHookName: 'InstanceTerminatingHook',
    //   notificationTarget: alternatTopicHook,
    //   notificationMetadata: "INFO: An instance has been terminated"
    // });

    /**
     *  WINDOWS LAUNCH TEMPLATE
     */

    const windowsInstanceRole = new Role(this, 'WindowsRole', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      roleName: "WindowsInstanceProfile"
    });

    windowsInstanceRole.addManagedPolicy({
      managedPolicyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
    })

    const windowsLaunchTemplateSG = new SecurityGroup(this, "WindowsLaunchTemplateSG", {
      vpc: vpc,
      securityGroupName: "WindowsLaunchTemplateSG"
    });

    windowsLaunchTemplateSG.addIngressRule(
      Peer.anyIpv4(), 
      Port.RDP, 
      "Ingress any IP to RPD"
    )

    const windowsLaunchTemplate = new LaunchTemplate(this, "WindowsLaunchTemplate", {
      // requireImdsv2: true,
      role: windowsInstanceRole,
      instanceType: InstanceType.of(InstanceClass.T3A, InstanceSize.LARGE),
      // machineImage: MachineImage.latestWindows(WindowsVersion.WINDOWS_SERVER_2022_ENGLISH_FULL_BASE),
      machineImage: MachineImage.genericWindows({
        'us-east-1': 'ami-0812a5ce5b386f439'
      }),
      keyPair: keyPair,
      launchTemplateName: "WindowsLaunchTemplate",
      securityGroup: windowsLaunchTemplateSG,
      blockDevices: [
        {
          deviceName: '/dev/sda1',
          volume: {
            ebsDevice: {
              deleteOnTermination: true,
              // iops: 3000,
              volumeSize: 50,
              volumeType: EbsDeviceVolumeType.GP3
            }
          }
        }
      ]
    });

    const windowsASG = new AutoScalingGroup(this, 'WindowsASG', {
      vpc: vpc,
      launchTemplate: windowsLaunchTemplate,
      minCapacity: 0,
      maxCapacity: 1,
      autoScalingGroupName: 'WindowsASG'
    });

  }
}
