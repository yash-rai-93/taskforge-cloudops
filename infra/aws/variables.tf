variable "aws_account_id" {
  type        = string
  description = "Expected AWS account. Provider authentication comes from a short-lived AWS profile."
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "Supply a 12-digit AWS account ID."
  }
}

variable "aws_region" {
  type        = string
  description = "Region for the isolated assessment stack."
  default     = "ap-south-1"
}

variable "availability_zone" {
  type        = string
  description = "Fixed zone for the EC2 host and its persistent data disk."
  default     = "ap-south-1a"
  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]+[a-z]$", var.availability_zone))
    error_message = "Use a standard EC2 availability zone, such as ap-south-1a."
  }
}

variable "ubuntu_ami_id" {
  type        = string
  description = "Pinned Canonical Ubuntu 24.04 amd64 AMI ID for the selected region."
  validation {
    condition     = can(regex("^ami-[0-9a-f]{17}$", var.ubuntu_ami_id))
    error_message = "Supply a full regional AMI ID."
  }
}

variable "name" {
  type        = string
  description = "Resource name prefix."
  default     = "taskforge-assessment"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name))
    error_message = "Use 3–31 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "instance_type" {
  type        = string
  description = "x86-64 T3 host size. The proposed baseline has 4 GiB of memory."
  default     = "t3.medium"
  validation {
    condition     = contains(["t3.small", "t3.medium", "t3.large"], var.instance_type)
    error_message = "Select t3.small, t3.medium or t3.large to match the amd64 images."
  }
}

variable "data_volume_gib" {
  type        = number
  description = "Size of the separate encrypted gp3 data volume."
  default     = 20
  validation {
    condition     = var.data_volume_gib >= 20 && var.data_volume_gib <= 100 && floor(var.data_volume_gib) == var.data_volume_gib
    error_message = "Supply a whole number between 20 and 100 GiB."
  }
}

variable "enable_public_web" {
  type        = bool
  description = "Open 80/443 after reviewing the DNS and TLS setup. Bootstrap starts private to SSM."
  default     = false
}

variable "ssh_ipv4_cidrs" {
  type        = set(string)
  description = "Optional trusted static IPv4 CIDRs for later SSH deployment."
  default     = []
  validation {
    condition     = alltrue([for cidr in var.ssh_ipv4_cidrs : can(cidrnetmask(cidr)) && can(regex("/(2[4-9]|3[0-2])$", cidr))])
    error_message = "SSH CIDRs must be valid IPv4 networks with /24 through /32 prefixes."
  }
}

variable "enable_ssm_cd" {
  type        = bool
  description = "Opt in to the GitHub production OIDC provider and instance-scoped Session Manager role."
  default     = false
}

variable "enable_smtp_egress" {
  type        = bool
  description = "Allow encrypted SMTP submission on TCP 465 for a configured production mail provider."
  default     = false
}
