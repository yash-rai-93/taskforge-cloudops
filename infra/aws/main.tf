locals {
  vpc_cidr    = "10.43.0.0/16"
  subnet_cidr = "10.43.1.0/24"
}

data "aws_ami" "ubuntu" {
  owners = ["099720109477"] # Canonical in standard AWS regions.

  filter {
    name   = "image-id"
    values = [var.ubuntu_ami_id]
  }

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }
}

resource "aws_vpc" "taskforge" {
  cidr_block           = local.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}

resource "aws_internet_gateway" "public" {
  vpc_id = aws_vpc.taskforge.id
  tags   = { Name = var.name }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.taskforge.id
  availability_zone       = var.availability_zone
  cidr_block              = local.subnet_cidr
  map_public_ip_on_launch = false
  tags                    = { Name = var.name }

  lifecycle {
    precondition {
      condition     = substr(var.availability_zone, 0, length(var.availability_zone) - 1) == var.aws_region
      error_message = "The availability zone must be in aws_region."
    }
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.taskforge.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.public.id
  }

  tags = { Name = var.name }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "host" {
  name        = var.name
  description = "TaskForge web and explicitly approved SSH access"
  vpc_id      = aws_vpc.taskforge.id
}

resource "aws_vpc_security_group_ingress_rule" "web" {
  for_each          = var.enable_public_web ? toset(["80", "443"]) : toset([])
  security_group_id = aws_security_group.host.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.key)
  to_port           = tonumber(each.key)
  description       = "Public web proxy"
}

resource "aws_vpc_security_group_ingress_rule" "ssh" {
  for_each          = var.ssh_ipv4_cidrs
  security_group_id = aws_security_group.host.id
  cidr_ipv4         = each.key
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
  description       = "Trusted static SSH client network"
}

resource "aws_vpc_security_group_egress_rule" "web" {
  for_each          = toset(["80", "443"])
  security_group_id = aws_security_group.host.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = tonumber(each.key)
  to_port           = tonumber(each.key)
  description       = "Package repositories, GHCR and Systems Manager"
}

resource "aws_iam_role" "host" {
  name = "${var.name}-ec2"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "host" {
  name = "${var.name}-ec2"
  role = aws_iam_role.host.name
}

resource "aws_ebs_volume" "data" {
  availability_zone = var.availability_zone
  encrypted         = true
  type              = "gp3"
  size              = var.data_volume_gib
  tags              = { Name = "${var.name}-data" }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_instance" "host" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  associate_public_ip_address = false
  vpc_security_group_ids      = [aws_security_group.host.id]
  iam_instance_profile        = aws_iam_instance_profile.host.name
  user_data_replace_on_change = true

  # Cloud-init receives the non-secret volume ID and the bootstrap program.
  user_data = "#cloud-config\n${yamlencode({
    ssh_pwauth   = false
    disable_root = true
    write_files = [
      {
        path        = "/usr/local/sbin/taskforge-bootstrap"
        permissions = "0750"
        content     = file("${path.module}/bootstrap.sh")
      },
      {
        path        = "/etc/taskforge/bootstrap.env"
        permissions = "0600"
        content     = "TASKFORGE_VOLUME_ID=${aws_ebs_volume.data.id}\n"
      }
    ]
    runcmd = [["/usr/local/sbin/taskforge-bootstrap"]]
  })}"

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  credit_specification {
    cpu_credits = "standard"
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = 12
    encrypted             = true
    delete_on_termination = true
  }

  tags       = { Name = var.name }
  depends_on = [aws_iam_role_policy_attachment.ssm, aws_route_table_association.public]
}

resource "aws_volume_attachment" "data" {
  device_name                    = "/dev/sdf"
  volume_id                      = aws_ebs_volume.data.id
  instance_id                    = aws_instance.host.id
  stop_instance_before_detaching = true
}

resource "aws_eip" "host" {
  domain = "vpc"
  tags   = { Name = var.name }
}

resource "aws_eip_association" "host" {
  instance_id   = aws_instance.host.id
  allocation_id = aws_eip.host.id
}
