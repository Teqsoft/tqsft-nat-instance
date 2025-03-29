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

    /*
     *  NAT Instance
     */
    
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

    /*
     *  Proxy Server to replace Load Balancer
     */

    const proxyLaunchTemplateSG = new SecurityGroup(this, "ProxyLaunchTemplateSG", {
      vpc: vpc,
      securityGroupName: "ProxyLaunchTemplateSG"
    });

    proxyLaunchTemplateSG.addIngressRule(
      Peer.ipv4(vpcCidr), 
      Port.allTraffic(), 
      "Ingress All Trafic in the subnet"
    )

    proxyLaunchTemplateSG.addIngressRule(
      Peer.anyIpv4(),
      Port.tcp(80),
      "Ingress for HTTP Traffic"
    )

    proxyLaunchTemplateSG.addIngressRule(
      Peer.anyIpv4(),
      Port.udp(10443),
      "Ingress for HTTP Traffic"
    )

    const proxtScript = UserData.custom(readFileSync('src/proxyScript.sh', 'utf8'));
              // .replace('${ROUTE_TABLES_IDS}',isolatedRouteTables));
    
    const multipartUserData4Proxy = new MultipartUserData();
    multipartUserData4Proxy.addPart(MultipartBody.fromUserData(cloudConfig, "text/cloud-config"));
    multipartUserData4Proxy.addPart(MultipartBody.fromUserData(proxtScript, "text/x-shellscript"));


    const proxyLaunchTemplate = new LaunchTemplate(this, "ProxyLaunchTemplate", {
      // requireImdsv2: true,
      role: instanceRole,
      instanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.NANO),
      machineImage: MachineImage.fromSsmParameter(
          "/aws/service/canonical/ubuntu/server-minimal/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id", {
            os: OperatingSystemType.LINUX,
            userData: multipartUserData4Proxy
        }
      ),
      keyPair: keyPair,
      launchTemplateName: "ProxyLaunchTemplate",
      securityGroup: proxyLaunchTemplateSG,
      
    });

    const proxyInstancesASG = new AutoScalingGroup(this, `proxy-instances-asg`, {
      vpc: vpc,
      launchTemplate: proxyLaunchTemplate,
      minCapacity: 0,
      maxCapacity: 1,
      vpcSubnets: {
        subnetType: SubnetType.PUBLIC
      },
      autoScalingGroupName: 'ProxyInstancesASG'
    });

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
      "Ingress for HTTP Traffic"
    )

    const proxyMergedScript = UserData.custom(readFileSync('src/merged-script.sh', 'utf8'));
              // .replace('${ROUTE_TABLES_IDS}',isolatedRouteTables));
    
    const multipartUserData4ProxyNat = new MultipartUserData();
    multipartUserData4ProxyNat.addPart(MultipartBody.fromUserData(cloudConfig, "text/cloud-config"));
    multipartUserData4ProxyNat.addPart(MultipartBody.fromUserData(proxyMergedScript, "text/x-shellscript"));


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

  }
}
