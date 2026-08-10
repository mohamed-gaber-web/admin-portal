output "resource_group_name" {
  value = azurerm_resource_group.this.name
}

output "app_hostname" {
  value = azurerm_linux_web_app.this.default_hostname
}

output "postgres_fqdn" {
  value = azurerm_postgresql_flexible_server.this.fqdn
}

output "redis_hostname" {
  value = azurerm_redis_cache.this.hostname
}

output "key_vault_uri" {
  value = azurerm_key_vault.this.vault_uri
}
