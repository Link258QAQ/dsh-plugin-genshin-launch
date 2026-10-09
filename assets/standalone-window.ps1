# 原神，启动！—— 独立窗口（原生 WinForms，不经任何浏览器内核）
#
# 这是"网页之外的独立窗口"的原生实现：直接用 .NET 的 System.Windows.Forms 画一个窗体，
# 通过 HTTP 打插件自己的路由（/status、/hello、/answer、/config、/rescan）拿数据、发指令。
#
# 为什么不用 Edge/Chrome 的 --app=：那需要一份浏览器 profile，而全新 profile 首次启动
# 一定会弹"首次使用 / 隐私收集"向导。对一个小面板来说那是不能接受的体验。原生窗口没有
# 这个问题，也不需要任何浏览器。
#
# 编码注意：本文件必须以 **UTF-8 with BOM** 保存。Windows PowerShell 5.1 读 .ps1 时
# 默认按 ANSI 解码，没有 BOM 的话下面所有中文都会变乱码。
param(
  [Parameter(Mandatory = $true)][int]$Port,
  [Parameter(Mandatory = $true)][string]$Token,
  [Parameter(Mandatory = $true)][string]$Tag,
  [int]$PollMs = 1500
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Base = "http://127.0.0.1:$Port/dsh-genshin-launch"
$Headers = @{ 'x-dsh-genshin-token' = $Token }

$script:Status = $null
$script:QuestionId = $null
$script:LastMessages = @()
$script:Failures = 0

function Invoke-Api {
  param([string]$Path, [string]$Method = 'Get', $Body = $null)
  $params = @{ Uri = "$Base$Path"; Method = $Method; Headers = $Headers; TimeoutSec = 10; UseBasicParsing = $true }
  if ($null -ne $Body) {
    $params.Body = ($Body | ConvertTo-Json -Compress)
    $params.ContentType = 'application/json'
  }
  return Invoke-RestMethod @params
}

# ---------------------------------------------------------------- 窗体
$form = New-Object System.Windows.Forms.Form
$form.Text = "原神，启动！ $Tag"
$form.Width = 430
$form.Height = 640
$form.StartPosition = 'Manual'
# 默认落在屏幕右下角，不挡住用户正在做的事
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Left = $screen.Right - $form.Width - 24
$form.Top = $screen.Bottom - $form.Height - 24
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(20, 24, 38)
$form.ForeColor = [System.Drawing.Color]::FromArgb(243, 234, 214)
$form.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$form.MinimizeBox = $false
$form.MaximizeBox = $false

function New-Label($text, $top, $size, $color) {
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $text
  $label.Left = 16
  $label.Top = $top
  $label.Width = $form.ClientSize.Width - 32
  $label.Height = $size
  $label.ForeColor = $color
  $label.Anchor = 'Left,Right,Top'
  return $label
}

$title = New-Label '原神，启动！' 14 26 ([System.Drawing.Color]::FromArgb(246, 220, 156))
$title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 13, [System.Drawing.FontStyle]::Bold)

$subtitle = New-Label '' 44 18 ([System.Drawing.Color]::FromArgb(180, 172, 150))

$detail = New-Object System.Windows.Forms.TextBox
$detail.Left = 16
$detail.Top = 68
$detail.Width = $form.ClientSize.Width - 32
$detail.Height = 300
$detail.Multiline = $true
$detail.ReadOnly = $true
$detail.ScrollBars = 'Vertical'
$detail.BackColor = [System.Drawing.Color]::FromArgb(14, 17, 28)
$detail.ForeColor = [System.Drawing.Color]::FromArgb(226, 219, 200)
$detail.BorderStyle = 'FixedSingle'
$detail.Anchor = 'Top,Left,Right,Bottom'
$detail.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)

# 问题区：宿主挂出问题（要不要扫盘 / 要不要信任新版安装包）时才出现
$questionBox = New-Object System.Windows.Forms.Panel
$questionBox.Left = 16
$questionBox.Top = 376
$questionBox.Width = $form.ClientSize.Width - 32
$questionBox.Height = 130
$questionBox.Anchor = 'Left,Right,Bottom'
$questionBox.BackColor = [System.Drawing.Color]::FromArgb(30, 34, 50)
$questionBox.Visible = $false

$questionText = New-Object System.Windows.Forms.Label
$questionText.Left = 10
$questionText.Top = 8
$questionText.Width = $questionBox.Width - 20
$questionText.Height = 80
$questionText.Anchor = 'Left,Right,Top'
$questionText.ForeColor = [System.Drawing.Color]::FromArgb(246, 220, 156)
$questionBox.Controls.Add($questionText)

$questionButtons = New-Object System.Windows.Forms.FlowLayoutPanel
$questionButtons.Left = 6
$questionButtons.Top = 92
$questionButtons.Width = $questionBox.Width - 12
$questionButtons.Height = 32
$questionButtons.Anchor = 'Left,Right,Bottom'
$questionButtons.FlowDirection = 'LeftToRight'
$questionBox.Controls.Add($questionButtons)

# 操作按钮
$actions = New-Object System.Windows.Forms.FlowLayoutPanel
$actions.Left = 16
$actions.Top = 512
$actions.Width = $form.ClientSize.Width - 32
$actions.Height = 40
$actions.Anchor = 'Left,Right,Bottom'
$actions.FlowDirection = 'LeftToRight'

function New-Button($text, $onClick, $width = 96) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $text
  $button.Width = $width
  $button.Height = 30
  $button.FlatStyle = 'Flat'
  $button.BackColor = [System.Drawing.Color]::FromArgb(48, 46, 40)
  $button.ForeColor = [System.Drawing.Color]::FromArgb(246, 220, 156)
  $button.FlatAppearance.BorderColor = [System.Drawing.Color]::FromArgb(120, 106, 66)
  $button.Add_Click($onClick)
  return $button
}

$quickInput = $null
function Show-PathDialog {
  $dialog = New-Object System.Windows.Forms.Form
  $dialog.Text = '快速配置原神路径'
  $dialog.Width = 560
  $dialog.Height = 220
  $dialog.StartPosition = 'CenterScreen'
  $dialog.TopMost = $true
  $dialog.BackColor = [System.Drawing.Color]::FromArgb(24, 28, 42)
  $dialog.ForeColor = [System.Drawing.Color]::FromArgb(243, 234, 214)
  $dialog.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
  $dialog.FormBorderStyle = 'FixedDialog'
  $dialog.MaximizeBox = $false
  $dialog.MinimizeBox = $false

  $hint = New-Object System.Windows.Forms.Label
  $hint.Text = "填游戏本体的 exe 全路径，或它所在的安装目录。填了就再也不用扫盘。`n出于隐私，界面只显示掩码路径；要修改请重新粘贴完整路径。"
  $hint.Left = 14; $hint.Top = 12; $hint.Width = $dialog.ClientSize.Width - 28; $hint.Height = 40
  $dialog.Controls.Add($hint)

  $box = New-Object System.Windows.Forms.TextBox
  $box.Left = 14; $box.Top = 58; $box.Width = $dialog.ClientSize.Width - 28; $box.Height = 26
  # 隐私：不回填掩码路径——原样提交会把 "D:\…\xxx.exe" 当完整路径写回去。
  $box.Text = ''
  $box.Anchor = 'Left,Right,Top'
  $dialog.Controls.Add($box)

  $error = New-Object System.Windows.Forms.Label
  $error.Left = 14; $error.Top = 90; $error.Width = $dialog.ClientSize.Width - 28; $error.Height = 34
  $error.ForeColor = [System.Drawing.Color]::FromArgb(255, 160, 140)
  $dialog.Controls.Add($error)

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = '确定'; $ok.Width = 88; $ok.Height = 30; $ok.Left = $dialog.ClientSize.Width - 200; $ok.Top = 132
  $ok.Anchor = 'Right,Bottom'
  $ok.BackColor = [System.Drawing.Color]::FromArgb(226, 192, 120)
  $ok.ForeColor = [System.Drawing.Color]::FromArgb(36, 29, 16)
  $ok.FlatStyle = 'Flat'
  $ok.Add_Click({
    $value = $box.Text.Trim()
    if ($value -eq '') { $error.Text = '请填一个路径，或者点取消。'; return }
    try {
      if ($value -match '\.exe$') { $payload = @{ gameExe = $value; gamePath = '' } }
      else { $payload = @{ gamePath = $value; gameExe = '' } }
      Invoke-Api -Path '/config' -Method 'Post' -Body $payload | Out-Null
      $dialog.Close()
    } catch {
      $error.Text = "写入失败：$($_.Exception.Message)"
    }
  })
  $dialog.Controls.Add($ok)

  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = '取消'; $cancel.Width = 88; $cancel.Height = 30; $cancel.Left = $dialog.ClientSize.Width - 104; $cancel.Top = 132
  $cancel.Anchor = 'Right,Bottom'
  $cancel.FlatStyle = 'Flat'
  $cancel.Add_Click({ $dialog.Close() })
  $dialog.Controls.Add($cancel)

  $dialog.AcceptButton = $ok
  $dialog.CancelButton = $cancel
  [void]$dialog.ShowDialog($form)
  Refresh-Status
}

function Send-Answer($id, $option) {
  try { Invoke-Api -Path '/answer' -Method 'Post' -Body @{ id = $id; option = $option } | Out-Null } catch { }
  # 选了「快速配置路径」就紧接着开第二个窗口（它是独立 Form，不会被本窗体挡住）
  if ($option -eq 'configure') { Show-PathDialog }
  Refresh-Status
}

function Refresh-Status {
  try {
    $status = Invoke-Api -Path '/status'
    $script:Failures = 0
  } catch {
    $script:Failures++
    $subtitle.Text = if ($script:Failures -gt 3) { '连不上 DSH 宿主了' } else { '正在连接…' }
    return
  }
  $script:Status = $status

  $subtitle.Text = "DSH 端口 $($status.endpoint.port) · 独立窗口"

  $lines = New-Object System.Collections.Generic.List[string]
  $lines.Add("状态：$($status.message)")
  if ($status.phase) { $lines.Add("阶段：$($status.phase)") }
  if ($status.game -and $status.game.found -and $status.game.exePath) { $lines.Add("本体：$($status.game.exePath)") }
  elseif ($status.game -and $status.game.registered) { $lines.Add("安装中：$($status.game.installDir)") }
  if ($status.error) { $lines.Add("错误：$($status.error)") }
  if ($status.downloaded) { $lines.Add("已下载：$([math]::Round($status.downloaded / 1MB, 1)) MB") }
  if ($status.config) {
    $cfg = $status.config
    if ($cfg.gameExe) { $lines.Add("手填 exe：$($cfg.gameExe)") }
    elseif ($cfg.gamePath) { $lines.Add("手填目录：$($cfg.gamePath)") }
    else { $lines.Add('手填路径：无（走零配置探测）') }
    if ($cfg.sizeBaselineBytes) { $lines.Add("体积基准：$([math]::Round($cfg.sizeBaselineBytes / 1MB)) MB（$(if ($cfg.sizeBaselineSource -eq 'learned') { '上次下载学到的' } else { '出厂值' })）") }
    if ($cfg.scanDone) { $lines.Add('扫盘：已扫过一次，不再自动扫') }
    if ($cfg.path) { $lines.Add("配置：$($cfg.path)") }
  }
  $detail.Text = ($lines -join "`r`n")

  # 问题区
  $question = $status.question
  if ($null -eq $question) {
    $questionBox.Visible = $false
    $script:QuestionId = $null
  } else {
    if ($script:QuestionId -ne $question.id) {
      $script:QuestionId = $question.id
      $questionText.Text = ($question.title + "`r`n" + (($question.lines | Select-Object -First 4) -join "`r`n"))
      $questionButtons.Controls.Clear()
      foreach ($option in $question.options) {
        $text = [string]$option.label
        $id = [string]$option.id
        $questionButtons.Controls.Add((New-Button $text { Send-Answer $script:QuestionId $id }.GetNewClosure() 110)) | Out-Null
      }
    }
    $questionBox.Visible = $true
  }
}

# ---------------------------------------------------------------- 装配
$form.Controls.AddRange(@($title, $subtitle, $detail, $questionBox, $actions))
$actions.Controls.Add((New-Button '填写路径' { Show-PathDialog })) | Out-Null
$actions.Controls.Add((New-Button '再扫一次' { try { Invoke-Api -Path '/rescan' -Method 'Post' -Body @{} | Out-Null } catch { }; Refresh-Status })) | Out-Null
$actions.Controls.Add((New-Button '刷新' { Refresh-Status } 72)) | Out-Null
$actions.Controls.Add((New-Button '关闭' { $form.Close() } 72)) | Out-Null

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = $PollMs
$timer.Add_Tick({ Refresh-Status })
$timer.Start()

$form.Add_Shown({
  # 告诉宿主「界面已经出现了」——所有有副作用的事都等这一下（和网页面板是同一条路）
  try { Invoke-Api -Path "/hello?mode=standalone" -Method 'Post' -Body @{} | Out-Null } catch { }
  Refresh-Status
})
$form.Add_FormClosed({ $timer.Stop() })

[void]$form.ShowDialog()
$timer.Stop()
