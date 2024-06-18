import * as cdk from 'aws-cdk-lib';
import { AutoScalingGroup } from 'aws-cdk-lib/aws-autoscaling';
import { InstanceClass, InstanceSize, InstanceType, KeyPair, LaunchTemplate, MachineImage, MultipartBody, MultipartUserData, OperatingSystemType, Peer, Port, SecurityGroup, SubnetType, UserData, Vpc, WindowsVersion } from 'aws-cdk-lib/aws-ec2';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { readFileSync } from 'fs';
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

    // WINDOWS LAUNCH TEMPLATE

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
      machineImage: MachineImage.latestWindows(WindowsVersion.WINDOWS_SERVER_2022_ENGLISH_FULL_BASE),
      keyPair: keyPair,
      launchTemplateName: "WindowsLaunchTemplate",
      securityGroup: windowsLaunchTemplateSG
    });

    // const windowsASG = new AutoScalingGroup(this, 'WindowsASG', {
    //   vpc: vpc,
    //   launchTemplate: windowsLaunchTemplate,
    //   minCapacity: 0,
    //   maxCapacity: 1,
    //   vpcSubnets: {
    //     subnetType: SubnetType.PUBLIC
    //   },
    //   autoScalingGroupName: 'WindowsASG'
    // });

  }
}
