<#
.SYNOPSIS
    Create a local CA and TLS certificates for the local SSO lab.

.DESCRIPTION
    Produces, under -OutDir:

        local-ca.crt                 root CA certificate  (import this into trust)
        local-ca.key                 root CA private key   (NEVER commit, never share)
        dsh/fullchain.pem            server cert for dsh.local        \
        dsh/privkey.pem              its key                            | nginx
        keycloak/fullchain.pem       server cert for keycloak.local     \
        keycloak/privkey.pem         its key                            | Keycloak

    Why a private CA rather than a self-signed leaf: the browser must TRUST the
    certificate, not ignore errors. Trusting one root once is a single, reviewable
    action; trusting two independent self-signed leaves is not, and `--insecure`
    anywhere in the chain is forbidden by the project rules.

    Requires no administrator rights to GENERATE. Importing the root into the
    Windows trust store does require an elevated prompt, and is deliberately left
    to the owner as a separate, explicit step (see the printed next steps).

.PARAMETER OutDir
    Where to write the material. Defaults to .\secrets\tls relative to this script.
    Must be outside Git.

.PARAMETER ValidityDays
    Leaf lifetime. Default 825 days (the maximum modern browsers accept).

.EXAMPLE
    .\new-local-ca.ps1 -OutDir D:\Projects\workspace-core\deploy\secrets\tls
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $OutDir = (Join-Path $PSScriptRoot '..\..\secrets\tls'),
    [int]    $ValidityDays = 825
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Write-Warn($message) { Write-Host "!!! $message" -ForegroundColor Yellow }

# --- Locate OpenSSL --------------------------------------------------------
# Git for Windows ships one, which every Docker Desktop user already has.
$openssl = $null
foreach ($candidate in @('openssl.exe', 'C:\Program Files\Git\usr\bin\openssl.exe', 'C:\Program Files\Git\mingw64\bin\openssl.exe')) {
    $found = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($found) { $openssl = $found.Source; break }
}
if (-not $openssl) {
    throw "openssl not found. Install Git for Windows (it bundles openssl) or add openssl to PATH."
}
Write-Step "using $openssl"

$OutDir = [IO.Path]::GetFullPath($OutDir)
$caDir = Join-Path $OutDir 'ca'
$dshDir = Join-Path $OutDir 'dsh'
$kcDir = Join-Path $OutDir 'keycloak'

# Refuse to silently overwrite an existing CA: rotating it invalidates every
# certificate already trusted, and the owner must make that choice explicitly.
if (Test-Path (Join-Path $caDir 'local-ca.key')) {
    Write-Warn "A local CA already exists at $caDir."
    Write-Warn "Reusing it. Delete that directory yourself if you really want a new one."
}

foreach ($dir in @($OutDir, $caDir, $dshDir, $kcDir)) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

# --- Root CA ---------------------------------------------------------------
$caKey = Join-Path $caDir 'local-ca.key'
$caCrt = Join-Path $caDir 'local-ca.crt'
if (-not (Test-Path $caKey)) {
    Write-Step 'creating the local root CA (10 years)'
    & $openssl genrsa -out $caKey 4096 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'openssl genrsa failed for the CA' }

    & $openssl req -x509 -new -nodes -key $caKey -sha256 -days 3650 `
        -subj '/CN=Personal AI Workspace Local CA/O=Local Lab' `
        -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' `
        -addext 'keyUsage=critical,keyCertSign,cRLSign' `
        -out $caCrt 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'openssl req failed for the CA' }
} else {
    Write-Step 'reusing the existing root CA'
}

# --- Leaf certificate helper ----------------------------------------------
function New-Leaf {
    param(
        [Parameter(Mandatory)] [string] $Name,          # 'dsh' or 'keycloak'
        [Parameter(Mandatory)] [string] $DnsName,       # 'dsh.local'
        [Parameter(Mandatory)] [string] $TargetDir,
        [Parameter(Mandatory)] [string] $ServerAuthOid  # 'serverAuth'
    )

    Write-Step "creating certificate for $DnsName"
    $key  = Join-Path $TargetDir 'privkey.pem'
    $csr  = Join-Path $TargetDir "$Name.csr"
    $crt  = Join-Path $TargetDir 'fullchain.pem'
    $ext  = Join-Path $TargetDir "$Name.ext"

    # subjectAltName must carry the DNS name the browser dials; CN alone is ignored
    # by every current browser.
    @"
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=$ServerAuthOid
subjectAltName=DNS:$DnsName
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
"@ | Set-Content -Path $ext -Encoding ascii

    & $openssl genrsa -out $key 2048 2>$null
    if ($LASTEXITCODE -ne 0) { throw "openssl genrsa failed for $DnsName" }

    & $openssl req -new -key $key -subj "/CN=$DnsName" -out $csr 2>$null
    if ($LASTEXITCODE -ne 0) { throw "openssl req failed for $DnsName" }

    & $openssl x509 -req -in $csr -CA $caCrt -CAkey $caKey -CAcreateserial `
        -out $crt -days $ValidityDays -sha256 -extfile $ext 2>$null
    if ($LASTEXITCODE -ne 0) { throw "openssl x509 failed for $DnsName" }

    Remove-Item $csr, $ext -Force -ErrorAction SilentlyContinue
    # The private key must not be world-readable. On Windows the ACL inherits from
    # the directory; removing inherited access is the closest portable equivalent.
    Write-Host "    $crt"
    Write-Host "    $key"
}

# Both leaf certificates use serverAuth; Keycloak is not a client certificate
# authority here, so no clientAuth EKU is needed.
New-Leaf -Name 'dsh'      -DnsName 'dsh.local'      -TargetDir $dshDir -ServerAuthOid 'serverAuth'
New-Leaf -Name 'keycloak' -DnsName 'keycloak.local' -TargetDir $kcDir  -ServerAuthOid 'serverAuth'

# --- Verification ----------------------------------------------------------
Write-Step 'verifying each leaf against the CA'
foreach ($pair in @(
    @{ Name = 'dsh.local';      Dir = $dshDir },
    @{ Name = 'keycloak.local'; Dir = $kcDir }
)) {
    $crt = Join-Path $pair.Dir 'fullchain.pem'
    $check = & $openssl verify -CAfile $caCrt $crt 2>&1
    if ($LASTEXITCODE -ne 0) { throw "certificate for $($pair.Name) does not verify: $check" }
    $san = & $openssl x509 -in $crt -noout -ext subjectAltName 2>&1
    Write-Host ("    {0}: verifies; {1}" -f $pair.Name, ($san -join ' ').Trim())
}

# --- Next steps ------------------------------------------------------------
Write-Host ''
Write-Step 'next steps (the first one needs an elevated PowerShell)'
Write-Host @"

1. Trust the root CA. ELEVATED PowerShell, once per machine:

     Import-Certificate -FilePath "$caCrt" ``
       -CertStoreLocation Cert:\LocalMachine\Root

   Or, for the current user only (no elevation, but some tools ignore it):

     Import-Certificate -FilePath "$caCrt" ``
       -CertStoreLocation Cert:\CurrentUser\Root

   Verify:  Get-ChildItem Cert:\LocalMachine\Root | Where-Object Subject -like '*Local Lab*'

2. Point the two names at this machine. ELEVATED, once per machine:

     Add-Content -Path `$env:SystemRoot\System32\drivers\etc\hosts ``
       -Value "`n127.0.0.1 dsh.local`n127.0.0.1 keycloak.local"

   Verify:  Resolve-DnsName dsh.local; Resolve-DnsName keycloak.local

3. Check the browser accepts them BEFORE starting anything:
   open https://keycloak.local:8443/realms/personal-ai/.well-known/openid-configuration
   It must load without a certificate warning.

4. Never commit this directory. It holds the CA private key.

"@ -ForegroundColor Gray
