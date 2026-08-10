terraform {
  # Remote state = reproducible environments (shared, locked state).
  # Fill in the storage account created out-of-band for state, then `terraform init`.
  backend "azurerm" {
    resource_group_name  = "tfstate-rg"
    storage_account_name = "growpathtfstate"
    container_name       = "tfstate"
    key                  = "dev.terraform.tfstate"
  }
}
