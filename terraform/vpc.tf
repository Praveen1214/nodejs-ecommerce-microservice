data "aws_availability_zones" "available" {}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "5.0.0"

  name = "k8s-research-vpc"
  cidr = "10.0.0.0/16"

  #azs             = slice(data.aws_availability_zones.available.names, 0, 2)
  #private_subnets = ["10.0.1.0/24", "10.0.2.0/24"]
  #public_subnets  = ["10.0.101.0/24", "10.0.102.0/24"]
  azs            = slice(data.aws_availability_zones.available.names, 0, 2)
  public_subnets = ["10.0.101.0/24", "10.0.102.0/24"]

  # enable_nat_gateway = true
  # single_nat_gateway = true
  # COST SAVING: Disable NAT Gateway
  enable_nat_gateway = false
  single_nat_gateway = false
  
  enable_dns_hostnames = true

  # Ensure nodes in public subnets get public IPs to reach the internet
  map_public_ip_on_launch = true

  tags = {
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
  }

  public_subnet_tags = {
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
    "kubernetes.io/role/elb"                  = "1"
  }
 #  private_subnet_tags = {
 #    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
 #    "kubernetes.io/role/internal-elb"         = "1"
 #  }
}

