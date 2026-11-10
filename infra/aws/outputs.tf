output "instance_id" {
  value       = aws_instance.host.id
  description = "EC2 instance ID for Systems Manager."
}

output "public_ipv4" {
  value       = aws_eip.host.public_ip
  description = "Stable IP for a future DNS record."
}

output "data_volume_id" {
  value       = aws_ebs_volume.data.id
  description = "Protected encrypted application disk."
}

output "deploy_root" {
  value       = "/srv/taskforge/deploy"
  description = "Persistent root for the existing release helper."
}
