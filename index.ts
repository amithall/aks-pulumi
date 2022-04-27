// Copyright 2016-2020, Pulumi Corporation.  All rights reserved.
import * as azuread from "@pulumi/azuread";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import * as tls from "@pulumi/tls";
import * as azure_native from "@pulumi/azure-native";
import * as k8s from "@pulumi/kubernetes";

import * as containerservice from "@pulumi/azure-native/containerservice";
import * as resources from "@pulumi/azure-native/resources";


// Variables

var tenantId = ""
var requesterEmail = ""
var keyVaultName = "mlo-kv-01"
var resourceGroupName = "rg-pulumi-aks"
var location = "westeurope"

// Create an Azure Resource Group
const resourceGroup = new resources.ResourceGroup(resourceGroupName);

// Get user objectId
const user = pulumi.output(azuread.getUser({
    userPrincipalName: requesterEmail,
}));

// Create a key vault

const vault = new azure_native.keyvault.Vault("vault", {
    location: location,
    resourceGroupName: resourceGroup.name,
    vaultName: keyVaultName,
    properties: {
        accessPolicies: [{
            objectId: user.objectId,
            permissions: {
                secrets: [
                    "get",
                    "list",
                    "set",
                    "delete",
                ],
                certificates: [
                    "get",
                ],
                keys: [
                    "get",
                ],
            },
            tenantId: tenantId,
        }],
        enabledForDeployment: true,
        enabledForDiskEncryption: true,
        enabledForTemplateDeployment: true,
        sku: {
            family: "A",
            name: "standard",
        },
        tenantId: tenantId,
    },
});

// Create an AD service principal
const adApp = new azuread.Application("aks", {
    displayName: "aks",
});
const adSp = new azuread.ServicePrincipal("aksSp", {
    applicationId: adApp.applicationId,
});

// Generate random password
const password = new random.RandomPassword("password", {
    length: 20,
    special: true,
});

// Create the Service Principal Password
const adSpPassword = new azuread.ServicePrincipalPassword("aksSpPassword", {
    servicePrincipalId: adSp.id,
    value: password.result,
    endDate: "2099-01-01T00:00:00Z",
});

// Generate an SSH key
const sshKey = new tls.PrivateKey("ssh-key", {
    algorithm: "RSA",
    rsaBits: 4096,
});

// Save the secrets
const sshSecret = new azure_native.keyvault.Secret("sshSecret", {
    properties: {
        value: sshKey.privateKeyPem,
    },
    resourceGroupName: resourceGroup.name,
    secretName: "ssh-key",
    vaultName: vault.name,
});

const clientSecret = new azure_native.keyvault.Secret("clientSecret", {
    properties: {
        value: password.result,
    },
    resourceGroupName: resourceGroup.name,
    secretName: "client-secret",
    vaultName: vault.name,
});

// Create cluster

const config = new pulumi.Config();
const managedClusterName = config.get("managedClusterName") || "azure-aks";
const cluster = new containerservice.ManagedCluster(managedClusterName, {
    resourceGroupName: resourceGroup.name,
    agentPoolProfiles: [{
        count: 3,
        maxPods: 110,
        mode: "System",
        name: "agentpool",
        nodeLabels: {},
        osDiskSizeGB: 30,
        osType: "Linux",
        type: "VirtualMachineScaleSets",
        vmSize: "Standard_DS2_v2",
    }],
    dnsPrefix: resourceGroup.name,
    enableRBAC: true,
    kubernetesVersion: "1.23.5",
    linuxProfile: {
        adminUsername: "cspadmin",
        ssh: {
            publicKeys: [{
                keyData: sshKey.publicKeyOpenssh,
            }],
        },
    },
    nodeResourceGroup: `MC_azure-go_${managedClusterName}`,
    servicePrincipalProfile: {
        clientId: adApp.applicationId,
        secret: adSpPassword.value,
    },
});

const creds = containerservice.listManagedClusterUserCredentialsOutput({
    resourceGroupName: resourceGroup.name,
    resourceName: cluster.name,
});

const encoded = creds.kubeconfigs[0].value;
export const kubeconfig = encoded.apply(enc => Buffer.from(enc, "base64").toString());

const nginxIngres = new k8s.helm.v3.Chart("nginx-ingres", {
    chart: "nginx-ingress",
    version: "1.24.4",
    namespace: "default",
    fetchOpts: {
        repo: "https://charts.helm.sh/stable",
    },
});