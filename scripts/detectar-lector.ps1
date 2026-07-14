# ============================================================================
# ¿QUÉ LECTOR DE HUELLA TIENE ENCHUFADO ESTE GYM?
# ----------------------------------------------------------------------------
# Nadie en el mostrador sabe la marca y el modelo de lo que compró, y no tiene
# por qué saberlo. La compu sí: cada aparato USB se identifica con un par de
# números (VID = fabricante, PID = modelo) que no mienten.
#
# CÓMO SE USA (en la compu donde está enchufado el lector, con el lector puesto):
#   1. Menú Inicio → escribir "PowerShell" → abrirlo.
#   2. Arrastrar este archivo a la ventana y apretar Enter.
#      (o pegar:  powershell -ExecutionPolicy Bypass -File detectar-lector.ps1)
#   3. Mandarnos lo que salga.
# ============================================================================

Write-Host ""
Write-Host "Buscando el lector de huella..." -ForegroundColor Cyan
Write-Host ""

# Los lectores se presentan de formas distintas segun el driver: como dispositivo
# biometrico, como HID, o crudos como USB. Miramos las tres.
$dispositivos = Get-PnpDevice -PresentOnly |
  Where-Object {
    $_.Class -in @('Biometric', 'HIDClass', 'USB', 'WinUsb', 'libusbK') -or
    $_.FriendlyName -match 'finger|huella|biometric|scanner|sensor'
  }

$encontrados = @()

foreach ($d in $dispositivos) {
  # El InstanceId trae VID_xxxx&PID_xxxx: es la matricula del aparato.
  if ($d.InstanceId -match 'VID_([0-9A-Fa-f]{4}).*PID_([0-9A-Fa-f]{4})') {
    $vid = $Matches[1].ToUpper()
    $pid = $Matches[2].ToUpper()

    # Los sospechosos de siempre. Si no esta en la lista igual lo reportamos:
    # la idea es que sirva con CUALQUIER lector, no solo con los que conozco.
    $marca = switch ($vid) {
      '05BA' { 'DigitalPersona / HID Global' }
      '1B55' { 'ZKTeco' }
      '2109' { 'ZKTeco (via hub)' }
      '1162' { 'SecuGen' }
      '1491' { 'Futronic' }
      '16D1' { 'Suprema' }
      '27C6' { 'Goodix' }
      '0483' { 'STMicro (lectores genericos)' }
      default { $null }
    }

    $esBiometrico = ($d.Class -eq 'Biometric') -or
                    ($d.FriendlyName -match 'finger|huella|biometric') -or
                    ($null -ne $marca)

    if ($esBiometrico) {
      $encontrados += [PSCustomObject]@{
        Nombre     = $d.FriendlyName
        Marca      = if ($marca) { $marca } else { '(desconocida)' }
        VID        = $vid
        PID        = $pid
        Clase      = $d.Class
        Estado     = $d.Status
        InstanceId = $d.InstanceId
      }
    }
  }
}

if ($encontrados.Count -eq 0) {
  Write-Host "No encontre ningun lector de huella." -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Revisa que:" -ForegroundColor Yellow
  Write-Host "  - el lector este enchufado AHORA (no basta con que lo tengan en un cajon)"
  Write-Host "  - sea el USB, no un aparato de pared con pantalla propia"
  Write-Host ""
  Write-Host "Si igual no aparece, mandanos una foto del aparato y de su cable." -ForegroundColor Yellow
} else {
  Write-Host "LECTOR(ES) ENCONTRADO(S):" -ForegroundColor Green
  Write-Host ""
  $encontrados | Format-List
  Write-Host "Copia TODO esto y mandanoslo." -ForegroundColor Green
}

Write-Host ""
Read-Host "Enter para cerrar"
