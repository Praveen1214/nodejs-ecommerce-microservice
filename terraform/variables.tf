variable "region" {
  description = "AWS region"
  type        = string
  default     = "ap-south-1"
}

variable "cluster_name" {
  description = "Name of the EKS cluster"
  type        = string
  default     = "k8s-research-cluster"
}

variable "node_type" {
  description = "EC2 instance type for nodes"
  type        = string
  default     = "t3.small"
}

variable "nodes" {
  description = "Desired number of nodes"
  type        = number
  default     = 2
}

variable "nodes_min" {
  description = "Minimum number of nodes"
  type        = number
  default     = 2
}

variable "nodes_max" {
  description = "Maximum number of nodes"
  type        = number
  default     = 2
}
