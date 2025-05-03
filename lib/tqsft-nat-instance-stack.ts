import * as cdk from 'aws-cdk-lib';
import { AutoScalingGroup, LifecycleTransition } from 'aws-cdk-lib/aws-autoscaling';
import { BlockDeviceVolume, EbsDeviceVolumeType, InstanceClass, InstanceSize, InstanceType, KeyPair, LaunchTemplate, MachineImage, MultipartBody, MultipartUserData, OperatingSystemType, Peer, Port, SecurityGroup, SubnetType, UserData, Vpc, WindowsVersion } from 'aws-cdk-lib/aws-ec2';
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

    /**
     *   User Data for Proxy Nat Server.
     */
    const cloudConfig = UserData.custom(readFileSync('src/cloud-config.txt','utf8'));
    const proxyNatScript = UserData.custom(readFileSync('src/proxy-nat-script.sh', 'utf8')
      .replace('${ROUTE_TABLES_IDS}',isolatedRouteTables)
    );

    const multipartUserData4ProxyNat = new MultipartUserData();
    multipartUserData4ProxyNat.addPart(MultipartBody.fromUserData(cloudConfig, "text/cloud-config"));
    multipartUserData4ProxyNat.addPart(MultipartBody.fromUserData(proxyNatScript, "text/x-shellscript"));

    /**
     *   Role Instance 
     */

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
    instanceRole.addToPolicy(new PolicyStatement({
      effect: Effect.ALLOW,
      actions: [
        's3:ListBucket',
        's3:ListObjectsV2',
        's3:GetObject',
        's3:PutObject'
      ],
      resources: [
        'arn:aws:s3:::ecs-clusters-space',
        'arn:aws:s3:::ecs-clusters-space/',
        'arn:aws:s3:::ecs-clusters-space/*'
      ]
    }));

    const keyPair = KeyPair.fromKeyPairName(this, "RaulRTKeyPair", keyPairName.valueAsString);

    /*
     *  NAT & Proxy Server in One
     */

    const proxyNatLaunchTemplateSG = new SecurityGroup(this, "ProxyNatLaunchTemplateSG", {
      vpc: vpc,
      securityGroupName: "ProxyNatLaunchTemplateSG"
    });

    proxyNatLaunchTemplateSG.addIngressRule(
      Peer.ipv4(vpcCidr), 
      Port.allTraffic(), 
      "Ingress All Trafic in the subnet"
    )

    proxyNatLaunchTemplateSG.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(80),
      "Ingress for HTTP Traffic"
    )

    proxyNatLaunchTemplateSG.addIngressRule(
      Peer.anyIpv4(),
      Port.udp(10443),
      "Ingress for WireGuard Traffic"
    )

    const proxyNatLaunchTemplate = new LaunchTemplate(this, "ProxyNatLaunchTemplate", {
      // requireImdsv2: true,
      role: instanceRole,
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.NANO),
      machineImage: MachineImage.fromSsmParameter(
          "/aws/service/canonical/ubuntu/server-minimal/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id", {
            os: OperatingSystemType.LINUX,
            userData: multipartUserData4ProxyNat
        }
      ),

      keyPair: keyPair,
      launchTemplateName: "ProxyNatLaunchTemplate",
      securityGroup: proxyNatLaunchTemplateSG,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: BlockDeviceVolume.ebs(6, {
            deleteOnTermination: true,
            encrypted: true,
            volumeType: EbsDeviceVolumeType.GP3
          })
        }
      ]
    });

    const proxyNatInstancesASG = new AutoScalingGroup(this, `proxyNatInstancesASG`, {
      vpc: vpc,
      launchTemplate: proxyNatLaunchTemplate,
      minCapacity: 0,
      maxCapacity: 1,
      vpcSubnets: {
        subnetType: SubnetType.PUBLIC
      },
      autoScalingGroupName: 'ProxyNatInstancesASG'
    });

  }
}
