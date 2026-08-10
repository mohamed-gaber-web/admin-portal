terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 3.100, < 5.0"
    }
  }
}

provider "azurerm" {
  features {}
}

module "environment" {
  source = "../../modules/environment"

  name                   = "growpath-staging"
  location               = var.location
  administrator_password = var.administrator_password
  tags = {
    project     = "growpath-admin"
    environment = "staging"
    managed_by  = "terraform"
  }
}
