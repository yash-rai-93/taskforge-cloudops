mock_provider "aws" {
  mock_data "aws_ami" {
    defaults = { id = "ami-09d8c1e69d114dbf7" }
  }
}

variables {
  aws_account_id = "000000000000"
  ubuntu_ami_id  = "ami-09d8c1e69d114dbf7"
}

run "isolated_ssm_host" {
  command = plan

  assert {
    condition     = length(aws_vpc_security_group_ingress_rule.web) == 0 && length(aws_vpc_security_group_ingress_rule.ssh) == 0
    error_message = "The bootstrap stack must have no inbound access by default."
  }

  assert {
    condition     = one(aws_instance.host.metadata_options).http_tokens == "required" && one(aws_instance.host.metadata_options).http_put_response_hop_limit == 1
    error_message = "The host must use IMDSv2 with hop limit 1."
  }

  assert {
    condition     = aws_ebs_volume.data.encrypted && aws_ebs_volume.data.size == 20 && one(aws_instance.host.root_block_device).encrypted
    error_message = "Both disks must be encrypted and the data disk must use the proposed capacity."
  }

  assert {
    condition     = aws_instance.host.instance_type == "t3.medium" && one(aws_instance.host.credit_specification).cpu_credits == "standard"
    error_message = "The proposed instance must stay on standard CPU credits."
  }

  assert {
    condition     = !aws_instance.host.associate_public_ip_address && aws_eip.host.domain == "vpc"
    error_message = "The host should have one stable public IPv4 via its Elastic IP."
  }
}

run "explicit_web_and_ssh" {
  command = plan

  variables {
    enable_public_web = true
    ssh_ipv4_cidrs    = ["192.0.2.10/32"]
  }

  assert {
    condition     = toset([for rule in aws_vpc_security_group_ingress_rule.web : rule.from_port]) == toset([80, 443])
    error_message = "Public ingress should be limited to web proxy ports."
  }

  assert {
    condition     = aws_vpc_security_group_ingress_rule.ssh["192.0.2.10/32"].from_port == 22
    error_message = "SSH should allow only the supplied trusted CIDR."
  }
}

run "reject_public_ssh" {
  command = plan

  variables {
    ssh_ipv4_cidrs = ["0.0.0.0/0"]
  }

  expect_failures = [var.ssh_ipv4_cidrs]
}
