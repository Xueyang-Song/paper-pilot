# Release Signing

Paper Pilot publishes a signed Windows NSIS installer from GitHub Actions. The release workflow uses Azure Artifact Signing through electron-builder.

## Azure Signing Resources

The release workflow expects these Azure resources:

- Subscription: `8b52aba2-7348-4d4a-abfd-132b6365187c`
- Tenant: `5556ae28-2fa4-474a-a064-7e0a65a5296e`
- Resource group: `PaperPilot`
- Artifact Signing account: `NeroCodeSign1`
- Endpoint: `https://wus3.codesigning.azure.net/`
- Certificate profile: `PaperPilotCert1`
- Publisher name: `Zhuowen Cui`

## One-Time Azure Setup

Create or reuse an Entra app registration named `paper-pilot-github-release-signer`.

```powershell
$subscriptionId = "8b52aba2-7348-4d4a-abfd-132b6365187c"
$tenantId = "5556ae28-2fa4-474a-a064-7e0a65a5296e"
$resourceGroup = "PaperPilot"
$signingAccount = "NeroCodeSign1"
$appName = "paper-pilot-github-release-signer"

az account set --subscription $subscriptionId

$app = az ad app create --display-name $appName | ConvertFrom-Json
$servicePrincipal = az ad sp create --id $app.appId | ConvertFrom-Json

$federatedCredential = @{
  name = "paper-pilot-release-environment"
  issuer = "https://token.actions.githubusercontent.com"
  subject = "repo:Xueyang-Song/paper-pilot:environment:release"
  audiences = @("api://AzureADTokenExchange")
} | ConvertTo-Json

$federatedCredentialPath = New-TemporaryFile
$federatedCredential | Set-Content -Path $federatedCredentialPath -Encoding ascii
az ad app federated-credential create --id $app.appId --parameters "@$federatedCredentialPath"
Remove-Item $federatedCredentialPath

$scope = "/subscriptions/$subscriptionId/resourceGroups/$resourceGroup/providers/Microsoft.CodeSigning/codeSigningAccounts/$signingAccount"
az role assignment create `
  --assignee-object-id $servicePrincipal.id `
  --assignee-principal-type ServicePrincipal `
  --role "Artifact Signing Certificate Profile Signer" `
  --scope $scope

$credential = az ad app credential reset `
  --id $app.appId `
  --append `
  --display-name "paper-pilot-github-release-ci" `
  --years 1 | ConvertFrom-Json
```

If Azure displays the older role name, use `Trusted Signing Certificate Profile Signer`; it maps to the same signing permission.

Store `$credential.password` as the `AZURE_CLIENT_SECRET` GitHub environment secret. Rotate this credential before its one-year expiration.

## GitHub Environment Setup

Create a GitHub environment named `release`.

- Do not require manual reviewers unless you want releases to pause before signing.
- Restrict deployments to release tags matching `v*.*.*`.
- When using `workflow_dispatch`, run the workflow from the tag ref in GitHub's "Use workflow from" selector.

Store these as environment variables on the `release` environment:

```text
AZURE_TENANT_ID=5556ae28-2fa4-474a-a064-7e0a65a5296e
AZURE_SUBSCRIPTION_ID=8b52aba2-7348-4d4a-abfd-132b6365187c
AZURE_CLIENT_ID=<new Entra app client ID>
AZURE_SIGNING_ENDPOINT=https://wus3.codesigning.azure.net/
AZURE_SIGNING_ACCOUNT_NAME=NeroCodeSign1
AZURE_SIGNING_CERTIFICATE_PROFILE_NAME=PaperPilotCert1
AZURE_SIGNING_PUBLISHER_NAME=Zhuowen Cui
```

Store this as an environment secret on the `release` environment:

```text
AZURE_CLIENT_SECRET=<Entra app client secret>
```

The non-sensitive values are referenced with GitHub Actions `vars`. `AZURE_CLIENT_SECRET` is referenced with GitHub Actions `secrets` and is only exposed to the signing job that targets the protected `release` environment.

## Release Flow

1. Update `package.json` to the version you want to publish.
2. Create and push a release tag such as `v0.1.1`.
3. GitHub Actions runs `npm run verify`, builds a Windows x64 NSIS installer, signs it with Azure Artifact Signing, verifies Authenticode signatures, and publishes the installer plus `SHA256SUMS.txt` to the GitHub Release.

## Local Checks

Run the unsigned local checks before tagging:

```bash
npm run verify
npm run package -- --win --x64 --publish never
```

Do not set `AZURE_SIGNING_ENABLED=1` locally unless the Azure signing variables are present and you intend to produce a signed build.
