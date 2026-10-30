# PanelVisual.ps1 -- 卡片的所有界面元素都在这里搭出来。
# 由 Panel.ps1 点号引入（dot-source），共用同一个变量作用域。

$script:ColTextPrimary   = [System.Windows.Media.Color]::FromArgb(255, 0x16, 0x18, 0x1D)
$script:ColTextSecondary = [System.Windows.Media.Color]::FromArgb(255, 0x5B, 0x65, 0x73)
$script:ColTextTertiary  = [System.Windows.Media.Color]::FromArgb(255, 0x8A, 0x93, 0xA0)
$script:ColTextLight     = [System.Windows.Media.Color]::FromArgb(255, 0xF4, 0xF6, 0xFA)
$script:ColTextLight2    = [System.Windows.Media.Color]::FromArgb(255, 0xC6, 0xCD, 0xD9)
$script:ColTextLight3    = [System.Windows.Media.Color]::FromArgb(255, 0x9A, 0xA4, 0xB2)

$script:FontFamily = New-Object System.Windows.Media.FontFamily('Microsoft YaHei UI, Segoe UI')

function New-Brush {
    param([System.Windows.Media.Color]$Color)
    return [System.Windows.Media.SolidColorBrush]::new($Color)
}

# 建一个文字块。$Brush 传 SolidColorBrush，后面改颜色直接改 .Color。
#
# 关键：每个文字块都套一层 DropShadowEffect。
# 磨砂卡片的背景千变万化（深浅混在一起的照片壁纸），光靠"深字/浅字"二选一总会翻车。
# 加一层同色系但反向的阴影，等于自己给自己造对比：
#   深色字 + 浅色光晕  /  浅色字 + 深色阴影
# 这样不管背后是啥，字都能读。
function New-UiText {
    param(
        [string]$Text = '',
        [double]$Size = 12,
        [System.Windows.Media.SolidColorBrush]$Brush = $null,
        [object]$Weight = $null,
        [string]$Trim = 'None',
        [string]$Align = 'Left',
        [switch]$NoShadow
    )
    $tb = New-Object System.Windows.Controls.TextBlock
    $tb.Text = $Text
    $tb.FontFamily = $script:FontFamily
    $tb.FontSize = $Size
    if ($null -ne $Brush) { $tb.Foreground = $Brush }
    if ($null -ne $Weight) { $tb.FontWeight = $Weight }
    if ($Trim -ne 'None') { $tb.TextTrimming = $Trim }
    switch ($Align) {
        'Center' { $tb.TextAlignment = 'Center' }
        'Right'  { $tb.TextAlignment = 'Right' }
        default  { $tb.TextAlignment = 'Left' }
    }
    if (-not $NoShadow) {
        $fx = New-Object System.Windows.Media.Effects.DropShadowEffect
        $fx.ShadowDepth = 0
        $fx.Direction = 0
        # 【v0.9.6：光晕按字号分两档】
        #   用户报"深色背景下小字可读性下降"。除了极性判据错（主因，见 Panel.ps1），
        #   还有一个叠加因素：光晕参数是**所有字号共用一套**的（BlurRadius=2 / Opacity=0.32）。
        #   这套参数对 13px 标题合适，对 10.5~11px 的小字就太弱 ——
        #   小字的笔画本来就细，光晕糊得不够，字的边缘就和背景混在一起。
        #
        #   实测（用户截图里的小字）：最暗像素 #5B6573，对它所在的玻璃 #687C8D
        #   只有 1.37:1 —— 字已经被光晕"洗白"到快消失了。
        #
        #   所以 <12 号字用更密的晕：BlurRadius 1.5（更集中）/ Opacity 0.45（更实）。
        #   为什么不是更粗：BlurRadius 超过 2 会让细笔画整体发光、
        #   反过来降低字的清晰度（"糊成一团"而不是"托起来"）。1.5 是集中而非扩散。
        if ($Size -lt 12) {
            $fx.BlurRadius = 1.5
            $fx.Opacity = 0.45
        }
        else {
            $fx.BlurRadius = 2
            $fx.Opacity = 0.32
        }
        $fx.Color = [System.Windows.Media.Color]::FromArgb(255, 255, 255, 255)
        $tb.Effect = $fx
        # 登记起来，背景明暗变化时统一换阴影颜色
        if ($null -eq $script:textShadowFx) { $script:textShadowFx = New-Object System.Collections.ArrayList }
        [void]$script:textShadowFx.Add($fx)
    }
    return $tb
}

# 把所有文字块的阴影换成指定颜色
function Set-TextShadowColor {
    param([System.Windows.Media.Color]$Color)
    if ($null -eq $script:textShadowFx) { return }
    foreach ($fx in $script:textShadowFx) {
        try { $fx.Color = $Color } catch { }
    }
}

# ---------------------------------------------------------------- 展开态（260 x 368）
function New-ExpandedPanel {
    param([double]$CardWidth = 260)

    $g = New-Object System.Windows.Controls.Grid
    $g.Margin = New-Object System.Windows.Thickness(0)

    # 7 行：上留白 / 标题 / 分隔线 / 任务列表 / 分隔线 / 底部 / 下留白
    #
    # 【底部这几行的分配为什么是 46 + 0，而不是 34 + 12】
    #   原来写成 34 + 12：底部文字在一个 34 高的行里居中，
    #   但它下面还压着一条 12 高的空白行。结果文字的几何中心在
    #   「分隔线到卡片底」这块区域里偏上了 6 个逻辑像素 ——
    #   肉眼看起来就是"字贴上边、下面空一块"。实测确认过：
    #   文字中心在 123 逻辑像素，而该区域中心应是 129。
    #
    #   改成 46 + 0 之后：
    #     · 底部行直接延伸到卡片底边，文字在其中居中 = 视觉居中
    #     · 合计仍是 12+30+1+1+46+0 = 90，和原来完全一样
    #     · 所以六档高度公式（98 + 54N）一个字都不用改
    #
    #   为什么不给文字加个 Margin 往下推 6：
    #      那只是把这一次的偏差糊上去。行高改成合适值才是根治，
    #      而且换字号、换档位时不会再偏。
    foreach ($h in @('12', '30', '1', '*', '1', '46', '0')) {
        $rd = New-Object System.Windows.Controls.RowDefinition
        if ($h -eq '*') { $rd.Height = New-Object System.Windows.GridLength(1, [System.Windows.GridUnitType]::Star) }
        else { $rd.Height = New-Object System.Windows.GridLength([double]$h) }
        [void]$g.RowDefinitions.Add($rd)
    }

    $pad = 14.0

    # ---- 标题行：状态点 + 标题文字
    $head = New-Object System.Windows.Controls.Grid
    $head.Margin = New-Object System.Windows.Thickness($pad, 0, $pad, 0)
    [System.Windows.Controls.Grid]::SetRow($head, 1)
    [void]$g.Children.Add($head)

    # 第 0 列放圆点（固定 14），第 1 列放标题（吃掉所有剩余宽度）
    $cdDot = New-Object System.Windows.Controls.ColumnDefinition
    $cdDot.Width = New-Object System.Windows.GridLength(14)
    [void]$head.ColumnDefinitions.Add($cdDot)
    $cdText = New-Object System.Windows.Controls.ColumnDefinition
    $cdText.Width = New-Object System.Windows.GridLength(1, [System.Windows.GridUnitType]::Star)
    [void]$head.ColumnDefinitions.Add($cdText)

    $dot = New-Object System.Windows.Shapes.Ellipse
    $dot.Width = 8
    $dot.Height = 8
    $dot.HorizontalAlignment = 'Left'
    $dot.VerticalAlignment = 'Center'
    $dot.Fill = New-Brush ([System.Windows.Media.Color]::FromArgb(255, 0x2F, 0x6F, 0xE4))
    [System.Windows.Controls.Grid]::SetColumn($dot, 0)
    [void]$head.Children.Add($dot)

    $headText = New-UiText -Text '空闲' -Size 13 -Brush (New-Brush $script:ColTextPrimary) `
        -Weight ([System.Windows.FontWeights]::SemiBold) -Trim 'CharacterEllipsis'
    $headText.VerticalAlignment = 'Center'
    [System.Windows.Controls.Grid]::SetColumn($headText, 1)
    [void]$head.Children.Add($headText)

    # ---- 分隔线
    $sep1 = New-Object System.Windows.Shapes.Rectangle
    $sep1.Height = 1
    $sep1.Fill = New-Brush ([System.Windows.Media.Color]::FromArgb(0x1A, 0, 0, 0))
    $sep1.Margin = New-Object System.Windows.Thickness($pad, 0, $pad, 0)
    $sep1.VerticalAlignment = 'Center'
    [System.Windows.Controls.Grid]::SetRow($sep1, 2)
    [void]$g.Children.Add($sep1)

    # ---- 任务列表容器
    # 不居中，顶部对齐：卡片高度是按行数算出来的，居中会让行数变化时文字上下漂。
    $list = New-Object System.Windows.Controls.StackPanel
    $list.Margin = New-Object System.Windows.Thickness($pad, 4, $pad, 4)
    $list.VerticalAlignment = 'Top'
    $list.ClipToBounds = $true
    [System.Windows.Controls.Grid]::SetRow($list, 3)
    [void]$g.Children.Add($list)

    $sep2 = New-Object System.Windows.Shapes.Rectangle
    $sep2.Height = 1
    $sep2.Fill = New-Brush ([System.Windows.Media.Color]::FromArgb(0x1A, 0, 0, 0))
    $sep2.Margin = New-Object System.Windows.Thickness($pad, 0, $pad, 0)
    $sep2.VerticalAlignment = 'Center'
    [System.Windows.Controls.Grid]::SetRow($sep2, 4)
    [void]$g.Children.Add($sep2)

    # ---- 底部：今日 Token + 峰谷倒计时
    $foot = New-Object System.Windows.Controls.Grid
    $foot.Margin = New-Object System.Windows.Thickness($pad, 0, $pad, 0)
    [System.Windows.Controls.Grid]::SetRow($foot, 5)
    [void]$g.Children.Add($foot)
    [void]$foot.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition))
    $cdRight = New-Object System.Windows.Controls.ColumnDefinition
    $cdRight.Width = New-Object System.Windows.GridLength(1, [System.Windows.GridUnitType]::Star)
    [void]$foot.ColumnDefinitions.Add($cdRight)

    $footLeft = New-UiText -Text '今日 0' -Size 11 -Brush (New-Brush $script:ColTextSecondary)
    $footLeft.VerticalAlignment = 'Center'
    [System.Windows.Controls.Grid]::SetColumn($footLeft, 0)
    [void]$foot.Children.Add($footLeft)

    $footRight = New-UiText -Text '' -Size 11 -Brush (New-Brush $script:ColTextSecondary) -Align 'Right'
    $footRight.VerticalAlignment = 'Center'
    [System.Windows.Controls.Grid]::SetColumn($footRight, 1)
    [void]$foot.Children.Add($footRight)

    # 整块面板加个细边，配合系统圆角更像一张卡片
    $frame = New-Object System.Windows.Controls.Border
    $frame.CornerRadius = New-Object System.Windows.CornerRadius(8)
    $frame.BorderThickness = New-Object System.Windows.Thickness(1)
    $frame.BorderBrush = New-Brush ([System.Windows.Media.Color]::FromArgb(0x30, 0xFF, 0xFF, 0xFF))
    $frame.Child = $g

    return [pscustomobject]@{
        Root     = $frame
        Dot      = $dot
        HeadText = $headText
        List     = $list
        FootLeft = $footLeft
        FootRight= $footRight
        Sep1     = $sep1
        Sep2     = $sep2
        Pad      = $pad
    }
}

# ---------------------------------------------------------------- 收起态（260 x 96）
function New-MiniPanel {
    $g = New-Object System.Windows.Controls.Grid

    $stack = New-Object System.Windows.Controls.StackPanel
    $stack.HorizontalAlignment = 'Center'
    $stack.VerticalAlignment = 'Center'

    $cap = New-UiText -Text '今日使用 Token' -Size 11 -Brush (New-Brush $script:ColTextSecondary) -Align 'Center'
    $cap.Margin = New-Object System.Windows.Thickness(0, 0, 0, 3)
    [void]$stack.Children.Add($cap)

    $val = New-UiText -Text '0' -Size 25 -Brush (New-Brush $script:ColTextPrimary) `
        -Weight ([System.Windows.FontWeights]::SemiBold) -Align 'Center'
    [void]$stack.Children.Add($val)

    [void]$g.Children.Add($stack)

    # 左上角一个小状态点，颜色随状态走
    $dot = New-Object System.Windows.Shapes.Ellipse
    $dot.Width = 7
    $dot.Height = 7
    $dot.HorizontalAlignment = 'Left'
    $dot.VerticalAlignment = 'Top'
    $dot.Margin = New-Object System.Windows.Thickness(13, 12, 0, 0)
    $dot.Fill = New-Brush ([System.Windows.Media.Color]::FromArgb(255, 0x8A, 0x93, 0xA0))
    [void]$g.Children.Add($dot)

    $frame = New-Object System.Windows.Controls.Border
    $frame.CornerRadius = New-Object System.Windows.CornerRadius(8)
    $frame.BorderThickness = New-Object System.Windows.Thickness(1)
    $frame.BorderBrush = New-Brush ([System.Windows.Media.Color]::FromArgb(0x30, 0xFF, 0xFF, 0xFF))
    $frame.Child = $g

    return [pscustomobject]@{
        Root = $frame
        Caption = $cap
        Value = $val
        Dot = $dot
    }
}

# ---------------------------------------------------------------- 单条任务行
function New-TaskRow {
    param([double]$CardWidth = 260, [double]$RowHeight = 52)

    # 结构：外层 Grid 高度固定，里面放一个内容块，内容块整体垂直居中。
    #
    # 为什么不用"按行高分段"的写法：
    #   之前把行高拆成 8 / 20 / 16 / 8，靠手动分配让文字居中。
    #   但 TextBlock 的实际渲染高度并不等于你给的行高（字号 12.5 的实际行高约 17，
    #   字号 11 约 15），于是文字在自己的格子里偏上或偏下，累计起来整块就偏了 5 像素。
    #
    # 现在的做法：不猜高度，把两行文字装进一个 StackPanel，
    # 让 StackPanel 按内容自然撑开，再用 VerticalAlignment=Center 交给 WPF 居中。
    # 这样不管字号怎么改，永远是准的。
    $g = New-Object System.Windows.Controls.Grid
    $g.Height = $RowHeight
    $g.Margin = New-Object System.Windows.Thickness(0, 0, 0, 2)

    $content = New-Object System.Windows.Controls.StackPanel
    $content.VerticalAlignment = 'Center'
    $content.HorizontalAlignment = 'Stretch'
    [void]$g.Children.Add($content)

    # 第一行：任务名（左）+ 已跑时长（右）
    $line1 = New-Object System.Windows.Controls.Grid
    [void]$line1.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition))
    $cdR = New-Object System.Windows.Controls.ColumnDefinition
    $cdR.Width = New-Object System.Windows.GridLength(1, [System.Windows.GridUnitType]::Star)
    [void]$line1.ColumnDefinitions.Add($cdR)
    [void]$content.Children.Add($line1)

    $name = New-UiText -Text '' -Size 12.5 -Brush (New-Brush $script:ColTextPrimary) `
        -Weight ([System.Windows.FontWeights]::SemiBold) -Trim 'CharacterEllipsis'
    $name.VerticalAlignment = 'Center'
    [System.Windows.Controls.Grid]::SetColumn($name, 0)
    [void]$line1.Children.Add($name)

    $elapsed = New-UiText -Text '' -Size 11 -Brush (New-Brush $script:ColTextSecondary) -Align 'Right'
    $elapsed.VerticalAlignment = 'Center'
    $elapsed.Margin = New-Object System.Windows.Thickness(8, 0, 0, 0)
    [System.Windows.Controls.Grid]::SetColumn($elapsed, 1)
    [void]$line1.Children.Add($elapsed)

    # ---- Actions 插槽（v0.8.0 悬浮窗审批）
    #
    # 【为什么是"插槽"而不是再写一个 New-ApprovalRow】
    #   任务行和审批行的骨架完全一样（两行文字 + 右侧一个位置），
    #   区别只是右侧放"已跑时长"还是放两个按钮。
    #   写两套界面的话：高度公式要维护两份、配色要同步两份、
    #   以后改字号要改两处 —— 维护成本翻倍，还容易改漏一个。
    #
    # 【不会撑破 52 高，算过了】
    #   行高 52，里面是垂直居中的 StackPanel 装两行文字：
    #   字号 12.5 实际行高约 17、字号 11 约 15，加 2 的间距 = 34。
    #   52 - 34 = 18 的余量，塞 24 高的按钮不撑破；
    #   VerticalAlignment=Center 让它和文字视觉居中对齐。
    #   所以**六档高度公式 98+54N 一个字都不用改**，
    #   开关切换时卡片高度完全不变（两种模式都是 1 行 54）。
    #
    # 【为什么和 Elapsed 放同一列、二选一显示】
    #   不新增列定义 → 不影响其它行布局；Collapsed 不参与布局 →
    #   开关关（默认）时行为和改动前完全一样。
    #   按钮 42×24，两个加间距约 90 宽；232 可用宽 - 90 = 142 给标题，
    #   中文标题截断后仍可读。
    $actions = New-Object System.Windows.Controls.StackPanel
    $actions.Orientation = 'Horizontal'
    $actions.HorizontalAlignment = 'Right'
    $actions.VerticalAlignment = 'Center'
    $actions.Visibility = 'Collapsed'
    $actions.Margin = New-Object System.Windows.Thickness(8, 0, 0, 0)
    [System.Windows.Controls.Grid]::SetColumn($actions, 1)
    [void]$line1.Children.Add($actions)

    # 【为什么预建而不是每次刷新新建】
    #   Update-UI 每 500ms 跑一次。每次 New 两个 Border+TextBlock
    #   就是一天十几万个对象 —— 和 Set-Header 里"预建画刷"同一个道理。
    $btnAllow = New-ApprovalButton -Text '允许' -Kind 'allow'
    $btnReject = New-ApprovalButton -Text '拒绝' -Kind 'reject'
    $btnAllow.Margin = New-Object System.Windows.Thickness(6, 0, 0, 0)
    [void]$actions.Children.Add($btnReject)
    [void]$actions.Children.Add($btnAllow)

    # 第二行：当前在做什么（左）+ 本次会话 Token（右）
    #
    # 【v0.10.0 用户拍板的方案 A1】
    #   用户原话："看图，放到那个 4秒 的下方"，随后在 A1/A2/A3 里选了 A1 ——
    #   Token 放在第二行**右侧**，"正在做什么"在左侧收窄。
    #
    # 【为什么不单独占第三行（A2）】
    #   实测（PS 5.1 WPF，字号 12.5/11/11，行间距 2）：
    #     现在两行：内容高 31.85，行高 52，余量 20.15
    #     加第三行：内容高 47.82，余量只剩 4.18
    #   余量 4px 太薄，字号/缩放一调就会被切掉，而且撑破会连带
    #   六档高度公式 98+54N 和所有验收数据重跑。所以走 A1。
    #
    # 【为什么不改 $RowHeight】
    #   A1 下内容高**仍是 31.85**（只是把一行拆成两列，行数没变），
    #   52 一点不动，六档高度公式一个字都不用改。
    #
    # 【代价（用户已知并接受）】
    #   "正在做什么"可用宽从 232 降到约 160（Token 约 64 宽 + 8 间距），
    #   中文从约 18 字降到约 14 字，长命令会更早变省略号。
    $line2 = New-Object System.Windows.Controls.Grid
    $line2.Margin = New-Object System.Windows.Thickness(0, 2, 0, 0)
    # 左列吃掉剩余宽度，右列 Auto（Token 字符串变长时右列自己变宽）
    [void]$line2.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition))
    $cdTok = New-Object System.Windows.Controls.ColumnDefinition
    $cdTok.Width = [System.Windows.GridLength]::Auto
    [void]$line2.ColumnDefinitions.Add($cdTok)
    [void]$content.Children.Add($line2)

    $activity = New-UiText -Text '' -Size 11 -Brush (New-Brush $script:ColTextSecondary) `
        -Trim 'CharacterEllipsis'
    # 必须 Stretch + 左列：否则文字块只按内容宽度占位，
    # 截断（CharacterEllipsis）永远算在"够宽"的一侧，省略号不会出现。
    $activity.VerticalAlignment = 'Center'
    $activity.HorizontalAlignment = 'Stretch'
    [System.Windows.Controls.Grid]::SetColumn($activity, 0)
    [void]$line2.Children.Add($activity)

    # Token 小字：字色和数据源由 Panel.ps1 的 Get-Row 统一挂（见那里的说明），
    # 这里只给形状。字号跟 activity 一致（11）—— 比它小会掉到 10.5 档，
    # 光晕参数会切到"更密"那一档，同一行里两种晕看着不一致。
    $tokens = New-UiText -Text '' -Size 11 -Brush (New-Brush $script:ColTextSecondary) -Align 'Right'
    $tokens.VerticalAlignment = 'Center'
    $tokens.Margin = New-Object System.Windows.Thickness(8, 0, 0, 0)
    [System.Windows.Controls.Grid]::SetColumn($tokens, 1)
    [void]$line2.Children.Add($tokens)

    return [pscustomobject]@{
        Root = $g; Name = $name; Elapsed = $elapsed; Activity = $activity
        Tokens = $tokens
        Actions = $actions; BtnAllow = $btnAllow; BtnReject = $btnReject
    }
}

# 审批行用的小按钮（v0.8.0）。
#
# 【为什么不用 WPF 默认 Button】
#   默认 Button 带系统主题的渐变底和边框，放在磨砂玻璃上像块补丁，
#   和整卡"通透 + 文字 + 圆点"的风格冲突。手搓一个：
#   无边框、半透明底、小圆角，和卡片其余元素同风格。
#
# 【为什么颜色直接写在这、不走 $script:Palette】
#   第一批的状态色板是"按相位取色"的（approval→红、running→蓝…）。
#   但这里的两个按钮是**同一行内**的两种语义色（允许=绿、拒绝=红），
#   不是"当前状态色"，硬塞进 Palette 会让那个表语义变混。
#   所以独立定义，但取值和 Palette 里的绿/红同源，视觉一致。
function New-ApprovalButton {
    param([string]$Text = '', [string]$Kind = 'allow')

    $b = New-Object System.Windows.Controls.Border
    $b.CornerRadius = New-Object System.Windows.CornerRadius(5)
    $b.Padding = New-Object System.Windows.Thickness(7, 2, 7, 2)
    $b.Cursor = [System.Windows.Input.Cursors]::Hand
    $b.MinWidth = 42
    $b.Height = 24

    $tb = New-Object System.Windows.Controls.TextBlock
    $tb.Text = $Text
    $tb.FontFamily = $script:FontFamily
    $tb.FontSize = 11
    $tb.TextAlignment = 'Center'
    $tb.VerticalAlignment = 'Center'
    $tb.HorizontalAlignment = 'Center'
    # 按钮文字不加光晕（NoShadow 语义）：小字号 + 光晕会糊成一团
    $b.Child = $tb

    $b.Tag = $Kind
    if ($Kind -eq 'allow') {
        $b.Background = New-Brush ([System.Windows.Media.Color]::FromArgb(0x33, 0x22, 0xA0, 0x5C))
        $tb.Foreground = New-Brush ([System.Windows.Media.Color]::FromArgb(0xFF, 0x3A, 0xC0, 0x78))
    }
    else {
        $b.Background = New-Brush ([System.Windows.Media.Color]::FromArgb(0x28, 0xE0, 0x40, 0x40))
        $tb.Foreground = New-Brush ([System.Windows.Media.Color]::FromArgb(0xFF, 0xF0, 0x70, 0x70))
    }

    return $b
}

# ---------------------------------------------------------------- 柱态（v0.9.0）
#
# 用户需求：沉浸任务时把悬浮窗缩成一根贴在屏幕边上的细柱，不显示任何文字，
# 只用颜色条表达"现在是什么状态"。
#
# 【为什么单独一个面板函数，不塞进 New-MiniPanel】
#   虽然结构只有三层，但它和 expanded/mini 的差别是根本性的：
#   零文字、零分隔线、零底栏、宽度只有 14。硬塞进现有面板会让两边都变脏
#   （现有面板的每个元素都要加"柱态下隐藏"的判断）。
#
# 【为什么颜色条必须是独立实色块，不能靠柱子整体染色】
#   实测（_lab\probe-bar-look.ps1，四张对比图）：
#     · 磨砂 + 半透明 tint → 整根柱子是"实心深色药丸"，染成状态色也看不出来
#     · 颜色条做成独立实色块 → 底是深色胶囊、中间一条亮色，状态一眼可辨
#   所以结构固定为：胶囊底（深/浅纯色）+ 中间一条实色。
#
# 【为什么用 Border.CornerRadius 画圆角，不靠 DWM 圆角】
#   DWM 圆角（属性 33）实测 hr=0 能成功，但半径由系统定（Win11 约 8 物理
#   = 4 逻辑）。柱宽 14 逻辑时，4 逻辑圆角做不出"胶囊"，看起来是圆角矩形。
#   自己画 CornerRadius = 宽度/2 才能做出真正的半圆端。
#   而且 DWM 圆角在每次改窗口尺寸后都可能被重置（Panel.ps1 里 Update-Glass
#   的注释就写了"改尺寸会把 DWM 的状态冲掉"），自己画的完全不受影响。
#
# 【⚠️ 用 Grid + 两个 Border 叠放，而不是 Border.Child = Border】
#   Border 只能有一个 Child，且 Child 会被 Padding 影响。
#   用 Grid 叠两层最直观：底层胶囊、上层颜色条，各自独立设对齐。
function New-BarPanel {
    param(
        [double]$BarWidth = 14,
        [double]$BarHeight = 120,
        [double]$StripWidth = 6,
        [double]$StripPadY = 12,
        # 【v0.9.9 描边 2.0 -> 1.0】
        #
        # 【用户反馈】"柱状态这个描边太丑了，太重了"
        #
        # 【"重"是怎么来的 —— 逐像素量出来的】
        #   用户机器 200% 缩放，14 逻辑宽的柱子在屏上是 28 物理像素。
        #   2.0 逻辑 = 4 物理像素宽 → 左边 4px 描边 + 4px 玻璃 + 6px 色条 + 4px 玻璃 + 4px 描边。
        #   描边和玻璃一样宽，看起来像给一根细条套了个画框（不是"玻璃边缘"）。
        #   _lab\probe-bar-border3.ps1 用产品真实 New-BarPanel 渲染并逐像素量：
        #     2.0 → 4 物理 / 单边占 14%
        #     1.0 → 2 物理 / 单边占  7%   ← 选这个
        #     0.75→ 1.5 物理（半像素，被抗锯齿洗淡成灰色，反而显脏）
        #
        # 【为什么是 1.0 而不是 0.75 或 0】
        #   · 0.75 逻辑 = 1.5 物理，落在半像素上，WPF 会用抗锯齿把它摊成两行淡灰，
        #     结果是"淡淡的灰雾"而不是"一条细边"，比 1.0 更脏。
        #   · 0（无描边）会退回 v0.9.5 的状态 —— 用户当时明确说"太透、可视性不佳"。
        #     玻璃浓度 0xA0 能撑出一块可见的底，但轮廓（柱子边缘在哪）还是要靠描边给。
        #   · 1.0 恰好 = 2 物理像素，是"能画出连续直线"的最小整数，不糊不粗。
        #
        # 【v0.9.7 曾把这里从 1.5 加到 2.0】
        #   当时的理由是"深色壁纸可读性不够"。这个判断本身没错，
        #   但加粗解决的是"轮廓对比度不足"，而对比度真正靠的是**颜色**，
        #   不是粗细 —— 4 像素的粗边只会更重、更笨，不会更清楚。
        #   所以 v0.9.9 改成"细一点 + 颜色微调"（见 Panel.ps1 的 $script:BarBorderColor）。
        [double]$BorderWidth = 1.0
    )

    # 【宽度/高度自检】参数被外部配置改坏时不能崩，也不能画出诡异的东西
    if ($BarWidth -lt 6)   { $BarWidth = 6 }
    if ($BarWidth -gt 40)  { $BarWidth = 40 }
    if ($BarHeight -lt 60) { $BarHeight = 60 }
    if ($BarHeight -gt 400){ $BarHeight = 400 }
    if ($StripWidth -lt 3) { $StripWidth = 3 }
    # 颜色条不能比柱子还宽（留 1 像素边）
    if ($StripWidth -gt ($BarWidth - 2)) { $StripWidth = $BarWidth - 2 }
    if ($StripPadY -lt 0)  { $StripPadY = 0 }

    $root = New-Object System.Windows.Controls.Grid
    # 【v0.9.2 不再写死 Root 的宽高】
    #   原来写 $root.Width = 14，等于要求"面板恰好 14 宽"。
    #   但柱态窗口宽度是 14 逻辑 → 200% 缩放 → 28 物理，
    #   系统取整后可能多/少 1 个物理像素，写死的面板就填不满窗口：
    #   少则露出窗口底色（用户看到的"没填满的缝"），多则被裁掉右边。
    #   改成 Stretch 铺满窗口客户区后，胶囊永远和窗口严丝合缝。
    #   宽度信息仍保留在 $BarWidth 参数里（圆角半径要用），只是不再约束布局。
    $root.HorizontalAlignment = 'Stretch'
    $root.VerticalAlignment   = 'Stretch'
    # 默认藏起来 —— 由 Set-WindowMode 显式打开。
    # 【为什么默认 Collapsed 而不是 Visible】面板在启动时就被建出来，
    # 那时是 expanded/mini 态，显示出来会在屏幕上闪一下小方块。
    $root.Visibility = 'Collapsed'

    # 底层：胶囊底（跟随壁纸明暗，由 Update-BarStrip 刷新）
    #
    # 【v0.9.1 重做样式：为什么不再是"永远深色"】
    #   旧版这里固定 0x1A1A1E，Update-BarStrip 里两个分支也都是深色。
    #   结果在浅色壁纸上柱子是一根"黑胶布"，和暖白的卡片完全不是一套语言。
    #   现在改成和卡片同一个规则：浅壁纸 → 暖灰底，深壁纸 → 深灰底。
    #   【注意】这里是**初始值**，真正的值由 Update-BarStrip 每次刷新时按
    #   $script:curIsLight 决定。这里给浅色是因为绝大多数壁纸偏浅。
    #
    # 【v0.9.2 为什么不再写死 Width/Height，改成拉伸铺满】
    #   用户实测反馈："磨砂材质似乎没有填满整个黑色边框，所以感觉有点偏"。
    #   原来这里 $bg.Width = 14 是**写死**的。而窗口宽度在 200% 缩放下
    #   会被系统按物理像素取整（14 逻辑 → 28 物理，但可用区可能少 1~2 逻辑），
    #   写死的 14 一旦比可用宽度大就被裁、比它小就露出下面的窗口底色（黑）。
    #   改成不设宽高 + 四个方向 Stretch，胶囊就会**精确等于**窗口客户区，
    #   边框不再有"没填满"的缝，色条也随之真正居中。
    $bg = New-Object System.Windows.Controls.Border
    $bg.HorizontalAlignment = 'Stretch'
    $bg.VerticalAlignment   = 'Stretch'
    # ================================================================
    # 【v0.9.8 重大改形：胶囊 → 纯直角矩形柱子】
    #
    # 【用户的原话】
    #   "既然系统不支持做圆角磨砂，那就不要胶囊态，改成柱子态，这样磨砂是不是就完美了"
    #
    # 【这个判断完全正确，而且比我之前给的 5 个方案都干净】
    #   磨砂玻璃是按**窗口矩形**合成的（见 归档-柱态矩形棱角限制.md）。
    #   所以只要"我们想要的形状" = "窗口矩形"，磨砂就永远不会超出形状之外。
    #   之前的问题根源是：我们想要胶囊（圆角），但窗口是矩形 → 四角漏出磨砂。
    #   改成矩形柱子之后，两者一模一样 → **棱角问题从根上消失**，不是"看不见了"，是"不存在了"。
    #
    #   而且这个方向本来就更符合"柱"这个字 ——
    #   历史上的名字一直叫"柱态/柱子"，只有视觉参数叫"胶囊"。
    #
    # 【为什么不加"1 像素小圆角"过渡】
    #   哪怕 1 像素圆角，四角也会漏出一点点磨砂（只是从 4px 缩到 1px）。
    #   用户选的是"纯直角矩形（磨砂完美）"，所以这里真的给 0 圆角。
    #   要柔和感就靠描边色和色条的圆角去给，不靠窗口形状。
    #
    # 【色条为什么还保留小圆角】
    #   色条是我们自己在窗口内部画的，不参与 DWM 合成，圆角完全可控。
    #   给它留 3px 圆角，柱子整体就不会显得太"硬"，
    #   而且能让人看出来"这是一条指示灯"，不是一块贴纸。
    $bg.CornerRadius = New-Object System.Windows.CornerRadius(0)
    $bg.Background = New-Brush ([System.Windows.Media.Color]::FromArgb(0xFF, 0xE8, 0xE2, 0xDF))

    # ---------------------------------------------------------- 胶囊描边（v0.9.6 重新加回）
    #
    # 【v0.9.3 当年为什么删掉，以及那个结论为什么是错的】
    #   用户当时反馈"胶囊背后有一个黑色矩形框"，逐像素量到那圈框是 #343434
    #   （alpha 0x34 = 52，半透明白叠在纯黑上算出来正好 52）。
    #   当时的结论写成两条：
    #     ① 半透明白描边叠在黑色窗口底上 → 变成灰框
    #     ② Border 的边框是【矩形】的，圆角处被抗锯齿削淡，所以像"矩形框套胶囊"
    #   第 ① 条是对的。**第 ② 条是错的**，本轮用离屏探针实测推翻了：
    #     _lab\probe-capsule-border.ps1 把同一个 Border 渲染到 200% 缩放下，
    #     逐行数描边像素，得到的是一条从窄到宽、跟着半圆走的曲线
    #     （x 位置逐行外扩，不是固定的左右两条竖线）→ 描边**跟随圆角**。
    #   所以删描边的真正理由只有"它是半透明的、叠在黑上被染色"这一条，
    #   而不是"Border 画不出胶囊边"。
    #
    # 【v0.9.6 为什么必须加回来】
    #   用户实测反馈："柱状态太透了，导致整个柱状态现在可视性不佳"。
    #   逐像素量他两张截图：胶囊和外侧壁纸的对比度只有 1.42（浅壁纸）/ 1.74（深壁纸），
    #   低于本项目给柱子定的轮廓门槛 1.20 之外的安全区，肉眼看就是"一根悬空的彩条"。
    #   原因是 v0.9.5 把磨砂浓度压到 0x20（13%）、又把胶囊底设成 Transparent，
    #   两条叠起来等于柱底几乎不存在。
    #   本轮同时做两件事：磨砂浓度提到 0xA0（见 Panel.ps1 的 $BarGlassAlpha）+ 加这道描边。
    #   实测（_lab\probe-border-width.ps1，四档并排图 border-widths-light/dark.png）：
    #     0    → 胶囊彻底融进壁纸（对照组，就是用户截图里的样子）
    #     1.0  → 圆头段被抗锯齿洗淡，顶部像有个缺口
    #     1.5  → 轮廓完整连续、不笨重   ← 选这个
    #     2.0  → 太粗，14 宽的柱子上像戴了个铁环
    #   1.5 逻辑像素在 200% 缩放下 = 3 物理像素，能整除、不会被取整吞掉。
    #
    # 【为什么这次不会变成灰框】
    #   ① 描边色 alpha 是 0xFF（完全不透明），不参与和窗口黑底的任何混合
    #   ② 窗口已经被 SetWindowRgn 裁成胶囊（v0.9.4 加的），矩形四角根本不存在
    #   ③ 描边色由 Update-BarStrip 按明暗实时刷新（浅色壁纸用深描边、深色用浅描边）
    #
    # 【代价】玻璃可绘制宽度从 14 变成 14-3 = 11 逻辑像素。
    #   色条 6 宽仍居中，两边各留 2.5 的玻璃边距 —— 比原来窄，但仍然有"嵌在玻璃里"的感觉。
    $bg.BorderThickness = New-Object System.Windows.Thickness($BorderWidth)
    $bg.BorderBrush = New-Brush ([System.Windows.Media.Color]::FromArgb(0xFF, 0x6E, 0x64, 0x60))
    [void]$root.Children.Add($bg)

    # 上层：颜色条（独立实色块）
    # 【为什么条宽 6 而不是 8】14 宽里条占 8 = 57%，看起来像"整根都是颜色"（糖果棒）。
    # 收到 6 = 43%，两边各留 4 像素"玻璃边距"，才像"嵌在玻璃里的指示灯"。
    #
    # 【v0.9.2 高度也改成跟随容器】
    #   原来是 $BarHeight - StripPadY*2（写死减 24）。柱高若被配置改过、
    #   或窗口高度被系统取整，条和胶囊的上下留白就不对称。
    #   改成 Margin 表达留白：上下各 StripPadY，高度自动 = 容器高 - 2*Pad，
    #   永远是居中的。
    $strip = New-Object System.Windows.Controls.Border
    $strip.Width  = $StripWidth
    $strip.Margin = New-Object System.Windows.Thickness(0, $StripPadY, 0, $StripPadY)
    $strip.CornerRadius = New-Object System.Windows.CornerRadius(3)
    $strip.HorizontalAlignment = 'Center'
    $strip.VerticalAlignment   = 'Stretch'
    $strip.Background = New-Brush ([System.Windows.Media.Color]::FromArgb(0xFF, 0x3A, 0x82, 0xF5))
    [void]$root.Children.Add($strip)

    return [pscustomobject]@{
        Root     = $root
        Backdrop = $bg
        Strip    = $strip
    }
}

# ---------------------------------------------------------------- 柱态悬停提示（v0.9.6 重做）
#
# 【要做什么】
#   鼠标停在柱子上时，旁边弹出一张**信息卡**，告诉用户"现在到底在跑什么"。
#
# 【v0.9.5 那版为什么被推翻（用户原话："弹窗很简陋"）】
#   旧版只有两行纯文字：
#       2 个任务运行中 · 1 个子智能体
#       单击展开 · 按住可拖动
#   问题不在"字少"，而在**它没有回答用户真正想问的问题**：
#     · 在跑的是哪几个任务？（旧版只给数量）
#     · 每个跑多久了？（旧版没有时间）
#     · 今天用了多少 Token / 谷时还有多久？（旧版没有，而这些卡片上都有）
#   而且旧版背景写死 0xF2 深灰，和卡片的磨砂玻璃完全不是一套语言，
#   浮在桌面上一眼就能看出"这是临时糊上去的东西"。
#
# 【新版的信息分层（从上到下）】
#   ① 状态头：8 像素状态圆点 + 状态文案（和卡片标题同句式）
#   ② 任务明细：最多 3 行，每行"标题（截断） / 已跑时长"，和卡片任务行同结构
#   ③ 底部指标：今日 Token（左） / 谷时倒计时（右），和卡片底部同结构
#   ④ 操作提示：单击展开 · 按住可拖动
#   两条 1 像素分隔线把 ①②③ 分开 —— 和展开卡片的骨架完全一致。
#
# 【为什么不塞进柱子窗口里】
#   柱子窗口只有 14 宽，气泡必须显示在柱子外侧 → 必须加宽窗口。
#   而柱子窗口被 SetWindowRgn 裁成了胶囊区域，加宽出来的区域会被裁掉；
#   要显示就得把 region 改成"胶囊 + 矩形"的并集，还要在悬停时改宽度、
#   重算 Left、重算 region —— 每一环都可能闪一下或裁错。
#   这块刚连续出过三个坑（见第四批报告第五节），不宜再往上叠复杂度。
#   所以气泡用独立窗口，两边互不干扰。
#
# 【不使用 WPF ToolTip 的原因】
#   ① 系统默认延迟不可精确控制（400~1000ms）
#   ② 样式受系统主题控制，做不到和卡片同一套玻璃质感
#   ③ 在 WS_EX_NOACTIVATE 窗口上行为不稳定（柱子正是这种窗口）
#
# 【配色为什么留两套（浅/深）】
#   气泡窗口也开磨砂（和卡片同一套语言）。既然透出背景，
#   文字色就必须分浅底/深底两套，否则和卡片当初踩的坑一样。
#   由 Panel.ps1 的 Update-BarTipTheme 按 $script:curIsLight 实时切换。
function New-BarTipPanel {
    param(
        [double]$MaxWidth = 236
    )

    $tip = New-Object System.Windows.Controls.Border
    # ================================================================
    # 【v0.9.9 弹窗圆角 10 -> 0：和柱子走同一条路，彻底消灭黑边】
    #
    # 【用户的反馈】
    #   "弹出的小窗现在样式对了，但是字还是有点糊，同时四周有黑边"
    #
    # 【黑边的真因：圆角外侧那块像素没人画】
    #   这是本项目第三次遇到同一个物理事实，值得一次说清：
    #     AllowsTransparency = False 是硬约束（改 True 磨砂就失效）。
    #     在这种窗口上，窗口底色 Transparent 实际等于**黑色**。
    #     WPF 只画面板的形状（圆角矩形），圆角外侧那 4 个小三角形
    #     不属于任何控件 → 没人擦 → 露出的就是窗口黑底。
    #   逐像素证据（用户截图 + 深色底板探针，位置都在四角）：
    #     y=2  x=[16..20] 和 x=[258..262]
    #     y=3  x=[11..15] 和 x=[263..267]
    #     ……越往下越往两边扩，正好是一条跟着圆角走的弧线。
    #   排查同时排除了两个"看起来很像"的原因：
    #     · 不是 DWM 磨砂造成的（开关磨砂，黑像素数完全一样）
    #     · 不是 DWM 圆角偏好造成的（ROUND / DONOTROUND 都一样，甚至更明显）
    #     · 不是之前那句 Border($hwnd,1) 造成的（那句是另一处，已单独删掉，
    #       它画的是四边直边的黑框；删掉之后直边干净了，只剩圆角这一圈）
    #
    # 【为什么解法是"改直角"而不是"把黑边涂成玻璃色"】
    #   涂色方案（在圆角面板下面垫一层铺满矩形的同色 Border）能遮住黑，
    #   但会露出**方块的四个尖角** —— 圆角外侧突然出现一个直角灰块，
    #   比黑边更怪。而改直角是让"形状 = 窗口矩形"，黑边**不存在**而不是"看不见"。
    #   这和柱态 v0.9.8 的做法完全一致（用户当时自己提的这个思路）。
    #   _lab\probe-tip-corners3.ps1 四方案并排图：tip13-corners.png
    #
    # 【代价】气泡失去圆润感，看起来更像"信息条"而不是"气泡"。
    #   用户已知情并选择这个方案（和柱子保持一致的视觉语言）。
    $tip.CornerRadius = New-Object System.Windows.CornerRadius(0)
    # 【为什么底色是 Transparent】
    #   v0.9.5 写死 0xF2 深灰 = 一块不透明的板子，磨砂完全看不出来。
    #   现在和卡片一样：窗口底色 Transparent + DWM 磨砂负责"玻璃"，
    #   所以 WPF 这一层不能画实色，否则把磨砂盖掉了。
    $tip.Background = [System.Windows.Media.Brushes]::Transparent
    # 细边（和卡片同一个值 0x30FFFFFF）—— 卡片那圈白边压在玻璃上才像"玻璃边缘"，
    # 气泡现在也有玻璃了，所以这圈边终于有了依附对象。
    $tip.BorderThickness = New-Object System.Windows.Thickness(1)
    $tip.BorderBrush = New-Brush ([System.Windows.Media.Color]::FromArgb(0x30, 0xFF, 0xFF, 0xFF))
    $tip.Padding = New-Object System.Windows.Thickness(12, 9, 12, 9)
    $tip.MaxWidth = $MaxWidth

    $sp = New-Object System.Windows.Controls.StackPanel

    # ================================================================ ① 直接进任务列表
    #
    # 【v0.9.8 按用户要求删掉"状态头"这一整块】
    #
    #   用户原话："也没有按照我们谈好的方式只显示任务+一个点，
    #              不需要上面的正在运行"
    #
    #   为什么删了反而更好：
    #     · "正在运行" 这四个字**没提供任何信息** —— 柱子是"有活干"才会出现的形态，
    #       点开弹窗必然是在运行状态。写一行"正在运行"等于把前提重复一遍。
    #     · 状态头那个圆点也和下面每行的点重复了（那个点是总结，下面的是明细）。
    #     · 删掉之后弹窗高度减少约 30 像素，鼠标扫过时不挡东西。
    #   保留的例外：**待审批**和**已完成**这两种"和平时不一样"的状态，
    #   确实需要一句提示（用户看到柱子变色了，需要知道为什么）。
    #   所以状态头改成"按需显示"：只有非 running 时才出现。

    # 【状态提示行：只在非 running 时显示】
    #   待审批 -> "有 N 项待你审批"（红点）
    #   已完成 -> "已完成"（绿点）
    #   running -> 整行 Collapsed（不占空间）
    $statusRow = New-Object System.Windows.Controls.Grid
    $statusRow.Visibility = 'Collapsed'
    $cdSD = New-Object System.Windows.Controls.ColumnDefinition
    $cdSD.Width = New-Object System.Windows.GridLength(10)
    [void]$statusRow.ColumnDefinitions.Add($cdSD)
    [void]$statusRow.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition))

    $statusDot = New-Object System.Windows.Shapes.Ellipse
    $statusDot.Width = 6
    $statusDot.Height = 6
    $statusDot.HorizontalAlignment = 'Left'
    $statusDot.VerticalAlignment = 'Center'
    $statusDot.Fill = New-Brush ([System.Windows.Media.Color]::FromArgb(0xFF, 0x2F, 0x6F, 0xE4))
    [System.Windows.Controls.Grid]::SetColumn($statusDot, 0)
    [void]$statusRow.Children.Add($statusDot)

    $title = New-Object System.Windows.Controls.TextBlock
    $title.FontFamily = $script:FontFamily
    $title.FontSize = 12
    $title.FontWeight = [System.Windows.FontWeights]::SemiBold
    $title.Foreground = New-Brush $script:ColTextLight
    $title.TextTrimming = 'CharacterEllipsis'
    $title.Text = ''
    $title.VerticalAlignment = 'Center'
    [System.Windows.Controls.Grid]::SetColumn($title, 1)
    [void]$statusRow.Children.Add($title)
    [void]$sp.Children.Add($statusRow)

    # 兼容旧字段名：Dot 仍指向状态提示行的点（Set-BarTipTheme 会用到）
    $dot = $statusDot

    # ---- 分隔线 1（状态提示行不显示时，这条也一并藏起来）
    $sep1 = New-Object System.Windows.Shapes.Rectangle
    $sep1.Height = 1
    $sep1.Fill = New-Brush ([System.Windows.Media.Color]::FromArgb(0x30, 0xFF, 0xFF, 0xFF))
    $sep1.Margin = New-Object System.Windows.Thickness(0, 0, 0, 6)
    $sep1.Visibility = 'Collapsed'
    [void]$sp.Children.Add($sep1)

    # ================================================================ ② 任务明细（最多 3 行）
    #
    # 【为什么预建 3 行而不是每次刷新重建】
    #   Update-UI 每 500ms 跑一次，悬停期间每次移动都会调 Show-BarTip。
    #   每次 New 就是一天十几万个短命控件（和 Set-Header 里"预建画刷"同一个道理）。
    #   预建 + 只改 .Text / .Visibility，代价几乎为零，也不会引起窗口闪烁。
    #
    # 【为什么是 3 行而不是 5 行】
    #   气泡是"瞥一眼"的信息层，不是主界面。3 行 + 一行"N 个更多"足够。
    #   5 行会让气泡高度逼近柱子的 120，贴边时容易盖住相邻内容。
    # 【v0.9.7 按用户要求改简略版：每个任务 = 一个状态点 + 任务名】
    #
    # 【为什么改】
    #   用户反馈："浮窗里显示的文字是被截断的，这个浮窗里的信息应该是简略的，
    #   不要直接复用大卡片的文字设计。我的想法是显示任务名，每个任务名前用带颜色的点
    #   显示任务状态。"
    #
    #   旧版复用了卡片的"左标题 + 右时长"两列结构，导致：
    #     · 弹窗最宽 236，减去内边距 24 只剩 212
    #     · 再减右侧时长列 ~40 + 间距 8，标题只剩 164
    #     · 164 装 13 个中文字（每字约 11.5px）→ 超过 8 个字就截断
    #   用户截图里"微信风前端重构"就是这么被截掉的。
    #
    #   新版：
    #     · 去掉时长列 → 标题可用宽度从 164 涨到 212（+29%）
    #     · 状态点放在文字左边（8px 点 + 8px 间距 = 16px），净可用 196
    #     · 字号从 11.5 降到 11.5 不变，但行高收紧、行间距从 3 降到 2
    #   状态点用相位色（和卡片圆点同一套 Palette），这样"哪个在跑、哪个在等审批"
    #   一眼能分辨，不靠读字。
    $rows = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt 4; $i++) {
        $line = New-Object System.Windows.Controls.Grid
        $line.Margin = New-Object System.Windows.Thickness(0, 0, 0, 2)
        $line.Visibility = 'Collapsed'
        # 第 0 列：状态点（固定 10）
        $cdD = New-Object System.Windows.Controls.ColumnDefinition
        $cdD.Width = New-Object System.Windows.GridLength(10)
        [void]$line.ColumnDefinitions.Add($cdD)
        # 第 1 列：任务名（占满剩余）
        [void]$line.ColumnDefinitions.Add((New-Object System.Windows.Controls.ColumnDefinition))
        # 第 2 列：已跑时长（v0.9.10 新增，Auto 宽度）
        #
        # 【用户要求】"柱状态鼠标放上去只显示个名称太空了，在右侧加个运行时间，
        #            只加东西，不要动 UI"
        #
        # 【为什么用 Auto 而不是固定像素】
        #   时长文本长度会变（"8秒" / "12分" / "1小时5分"）。
        #   固定宽度要么装不下被截断，要么永远留一块空白。
        #   Auto = 列宽跟着文字走，不同长度都刚好贴合。
        #
        # 【为什么"只加一列"不会破坏原布局】
        #   第 1 列是 Star（占满剩余），新增一个 Auto 列之后，
        #   Star 列的宽度自动 = 总宽 - 10 - 时长宽。
        #   也就是说标题可用宽度会**变窄**（这是唯一的副作用，下面有具体数值）。
        #   没有动任何已有控件的属性：圆点位置、字号、行高、外边距全部原样。
        $cdE = New-Object System.Windows.Controls.ColumnDefinition
        $cdE.Width = [System.Windows.GridLength]::Auto
        [void]$line.ColumnDefinitions.Add($cdE)

        $rd = New-Object System.Windows.Shapes.Ellipse
        $rd.Width = 6
        $rd.Height = 6
        $rd.HorizontalAlignment = 'Left'
        $rd.VerticalAlignment = 'Center'
        $rd.Fill = New-Brush ([System.Windows.Media.Color]::FromArgb(0xFF, 0x2F, 0x6F, 0xE4))
        [System.Windows.Controls.Grid]::SetColumn($rd, 0)
        [void]$line.Children.Add($rd)

        $rn = New-Object System.Windows.Controls.TextBlock
        $rn.FontFamily = $script:FontFamily
        $rn.FontSize = 11.5
        $rn.Foreground = New-Brush $script:ColTextLight2
        # 【为什么用 CharacterEllipsis 而不是不截断】
        #   极端长的标题（比如带路径的任务名）如果换行，弹窗会突然变很高、
        #   盖住下面的内容。截断 + 省略号是"高度可预测"的代价。
        #   但现在的可用宽度比旧版多 29%，常见的中文标题（10~12 字）能完整显示。
        $rn.TextTrimming = 'CharacterEllipsis'
        $rn.Text = ''
        $rn.VerticalAlignment = 'Center'
        [System.Windows.Controls.Grid]::SetColumn($rn, 1)
        [void]$line.Children.Add($rn)

        # ---- 已跑时长（v0.9.10 新增，第 2 列）
        #
        # 【文案从哪来】和卡片任务行同一套：都走 Panel.ps1 的 Format-Elapsed，
        #   产出 "45秒" / "12分" / "1小时5分"。两边永远不会出现"弹窗说 12 分、
        #   卡片说 12分30秒"这种对不上的情况。
        #
        # 【为什么字号比任务名小一档（10.5 vs 11.5）】
        #   时长是**辅助信息**，任务名才是主体。同字号会让右边比左边更抢眼
        #   （数字字形宽、笔画密）。小一档 + 用弱文字色，视觉层次才对。
        #
        # 【为什么不加秒（比如 "12分03秒"）】
        #   弹窗是悬停时瞥一眼的东西，秒级的精确度没有意义，
        #   反而让这列变宽 40%、挤掉任务名的宽度。Format-Elapsed 本身就是
        #   分段只显示两个单位，和卡片保持一致。
        $re = New-Object System.Windows.Controls.TextBlock
        $re.FontFamily = $script:FontFamily
        $re.FontSize = 10.5
        $re.Foreground = New-Brush $script:ColTextLight3
        $re.Text = ''
        $re.VerticalAlignment = 'Center'
        $re.HorizontalAlignment = 'Right'
        $re.Margin = New-Object System.Windows.Thickness(8, 0, 0, 0)
        [System.Windows.Controls.Grid]::SetColumn($re, 2)
        [void]$line.Children.Add($re)

        [void]$sp.Children.Add($line)
        [void]$rows.Add([pscustomobject]@{ Root = $line; Dot = $rd; Name = $rn; Time = $re })
    }

    # 行数溢出时的一行提示（"还有 N 个任务"）
    $more = New-Object System.Windows.Controls.TextBlock
    $more.FontFamily = $script:FontFamily
    $more.FontSize = 10.5
    $more.Foreground = New-Brush $script:ColTextLight3
    $more.Text = ''
    $more.Visibility = 'Collapsed'
    [void]$sp.Children.Add($more)

    # 【v0.9.7 删掉"分隔线 2 + 底部 Token/谷时"】
    #
    # 【为什么删】
    #   用户要求"信息应该是简略的，不要直接复用大卡片的文字设计"。
    #   Token / 谷时这两项在**展开卡片底部一直都有**，用户想看随时单击展开就能看到。
    #   塞进悬停弹窗只是重复信息，还占了 20 多像素高度、挤掉了任务名的宽度。
    #
    # 【代价（接受）】
    #   悬停时看不到 Token 了。这是用户明确要的取舍 —— 弹窗只回答"现在在跑什么"，
    #   不回答"今天用了多少"。两个问题分开在两个界面回答，反而更清楚。

    # ================================================================ ③ 操作提示
    # 【为什么要写这行】用户不知道柱态能拖、能点。不写提示等于功能白做。
    # 【v0.9.7 为什么保留它而删掉底部指标】
    #   它是**操作指引**，不是数据。删了用户就不知道能点、能拖（这功能等于白做）；
    #   而 Token/谷时是数据，展开卡片里已经有了。
    $hint = New-Object System.Windows.Controls.TextBlock
    $hint.FontFamily = $script:FontFamily
    $hint.FontSize = 10
    $hint.Foreground = New-Brush $script:ColTextLight3
    $hint.TextWrapping = 'Wrap'
    $hint.Margin = New-Object System.Windows.Thickness(0, 6, 0, 0)
    $hint.Text = '单击展开 · 按住可拖动'
    [void]$sp.Children.Add($hint)

    $tip.Child = $sp

    return [pscustomobject]@{
        Root      = $tip
        Title     = $title
        Dot       = $dot
        StatusRow = $statusRow
        Sep1      = $sep1
        Rows      = $rows
        More      = $more
        Hint      = $hint
    }
}

# 按明暗切换气泡的整套文字色（v0.9.6）
#
# 【为什么要单独一个函数，不直接改 4 个画刷】
#   气泡里的文字控件有十几个（标题/圆点/3 行 x 2 列/更多/两处底部/提示），
#   而且它们各有各的"档位"（主要/次要/更弱）。
#   在这里集中按 $script:curIsLight 选一套色，调用方只调一次 ——
#   以后调色只改这张表，不用去追十几个控件。
#
# 【色值从哪来】
#   直接复用 PanelVisual.ps1 顶部那组 ColTextLight / ColTextLight2 / ColTextLight3
#   和面板里默认写死的那套深字色，保证气泡和卡片是同一套语言。
#   对比度实测（气泡玻璃 rel ≈ 0.036 深底 / ≈ 0.98 浅底）：
#     深底：标题 #F2F4F8 → 13.4，明细 #DDDDDF → 11.3，弱 #9AA3B0 → 7.6
#     浅底：标题 #16181D → 15.9，明细 #3F4855 → 7.8，弱 #5F6977 → 5.2
function Set-BarTipTheme {
    param([bool]$IsLight)

    if ($null -eq $script:barTipPanel) { return }
    $p = $script:barTipPanel
    try {
        if ($IsLight) {
            # 浅背景 → 深字
            $cTitle = [System.Windows.Media.Color]::FromArgb(255, 0x16, 0x18, 0x1D)
            $cBody  = [System.Windows.Media.Color]::FromArgb(255, 0x33, 0x3B, 0x46)
            # 【v0.9.6 弱文字从 #5F6977 压到 #48525C】
            #   子代理实测：气泡磨砂 0xA0 时 #5F6977 只有 3.73，不达标；
            #   #48525C 是 5.34。气泡里有三处弱文字（时长/指标/提示），都得读得清。
            $cWeak  = [System.Windows.Media.Color]::FromArgb(255, 0x48, 0x52, 0x5C)
            $cSep   = [System.Windows.Media.Color]::FromArgb(0x24, 0, 0, 0)
            $cBrd   = [System.Windows.Media.Color]::FromArgb(0x34, 0x00, 0x00, 0x00)
        }
        else {
            # 深背景 → 浅字
            $cTitle = [System.Windows.Media.Color]::FromArgb(255, 0xF7, 0xF9, 0xFC)
            $cBody  = [System.Windows.Media.Color]::FromArgb(255, 0xDD, 0xE3, 0xEC)
            $cWeak  = [System.Windows.Media.Color]::FromArgb(255, 0xB8, 0xC2, 0xD0)
            $cSep   = [System.Windows.Media.Color]::FromArgb(0x30, 0xFF, 0xFF, 0xFF)
            $cBrd   = [System.Windows.Media.Color]::FromArgb(0x30, 0xFF, 0xFF, 0xFF)
        }

        $p.Title.Foreground.Color = $cTitle
        $p.Hint.Foreground.Color  = $cWeak
        $p.More.Foreground.Color  = $cWeak
        $p.Sep1.Fill.Color        = $cSep
        $p.Root.BorderBrush.Color = $cBrd
        foreach ($r in $p.Rows) {
            $r.Name.Foreground.Color = $cBody
            # 【v0.9.10】新增的时长列用"弱文字色"，比任务名低一档。
            #   为什么不用 $cBody：时长是辅助信息，和任务名同色会分不出主次。
            #   $cWeak 在两种底子上都过 5.0（浅 5.34 / 深 7.6），作为 10.5 号小字够读。
            #   注意这里必须用 $r.Time，不能漏 —— 漏了的话深色壁纸下时长会一直是
            #   浅色默认值（$script:ColTextLight3 是给深底准备的浅灰），
            #   在浅底上就是"浅灰字压浅玻璃"，几乎看不见。
            $r.Time.Foreground.Color = $cWeak
        }
    } catch { }
}

