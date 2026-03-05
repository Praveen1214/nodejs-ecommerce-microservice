module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = var.cluster_name
  cluster_version = "1.32"

  cluster_endpoint_public_access = true

  # Networking
  vpc_id     = module.vpc.vpc_id
  # subnet_ids = module.vpc.private_subnets
  subnet_ids = module.vpc.public_subnets

  # EKS Managed Node Group
  eks_managed_node_groups = {
    workers = {
      min_size     = var.nodes_min
      max_size     = var.nodes_max
      desired_size = var.nodes

      instance_types = [var.node_type]
      capacity_type  = "SPOT"
    }
  }



  # Cluster access entry
  # To allow the user creating the cluster to administer it
  enable_cluster_creator_admin_permissions = true

  tags = {
    Environment = "research"
    Terraform   = "true"
  }
}
