// Toast 通知（PowerShell + WinRT 自实现，替代 powertoast/powerballoon）
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { exists } from "../../shared/fsx.js";
import { log } from "../../shared/log.js";
import { resolveSound } from "../../core/config.js";

const DEFAULT_AUMID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

function xmlEscape(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 用独立隐藏 PowerShell 播放音频，播完自行退出。
// 关键点1：-EncodedCommand（UTF-16LE base64）彻底绕开中文/空格/引号路径的转义问题。
// 关键点2：不要用 detached:true —— Windows 上它会让 PowerShell 静默秒退（DETACHED_PROCESS 下啥也不干）。
//          用 windowsHide 即可；父进程退出不影响已启动的子进程继续播放。
function playAudioDetached(filePath) {
  const uri = "file:///" + path.resolve(filePath).replace(/\\/g, "/").replace(/'/g, "%27");
  const script = `Add-Type -AssemblyName presentationCore
$p = New-Object System.Windows.Media.MediaPlayer
$p.Open([Uri]'${uri}')
Start-Sleep -Milliseconds 250
$p.Play()
Start-Sleep -Milliseconds 300
while (-not $p.NaturalDuration.HasTimeSpan) { Start-Sleep -Milliseconds 100 }
Start-Sleep -Milliseconds ([int]($p.NaturalDuration.TimeSpan.TotalMilliseconds) + 400)
$p.Close()`;
  try {
    const b64 = Buffer.from(script, "utf16le").toString("base64");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", b64], {
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => { /* 忽略：无声音不影响通知 */ });
    child.unref();
  } catch { /* 忽略 */ }
}

export async function sendToast({ title, message, icon, appId, sound, attribution }) {
  let iconUri = "";
  if (icon && /^https?:/.test(icon)) {
    // http 图标 WinRT 不收，调用方应先 prefetch 成本地路径；此处兜底忽略
    iconUri = "";
  } else if (icon && (await exists(icon))) {
    iconUri = "file:///" + path.resolve(icon).replace(/\\/g, "/");
  }

  // 音效：default=系统默认；silent=静音；system:XXX=系统音；wav/mp3 路径=静音 Toast + 自己播放（支持任意音频）
  const snd = resolveSound(sound);
  let audioTag = "";
  let playBlock = "";
  if (snd.kind === "silent") audioTag = `<audio silent="true"/>`;
  else if (snd.kind === "system") {
    const ev = /^[A-Za-z.]+$/.test(snd.name || "") ? snd.name : "Default";
    audioTag = `<audio src="ms-winsoundevent:Notification.${ev}"/>`;
  } else if (snd.kind === "wav") {
    audioTag = `<audio silent="true"/>`;
    if (await exists(snd.path)) {
      // 独立隐藏进程播放：Toast 的 PowerShell 会立刻退出，同进程播放会被截断
      playAudioDetached(snd.path);
    } else {
      // 默认路径下的文件是用户自备的，缺失属正常情况：静默回落系统默认提示音
      log.info(`[TOAST] 音效文件不存在（${snd.path}），本次使用系统默认提示音`);
      audioTag = "";
    }
  }
  const attributionTag = attribution ? `<text placement="attribution">${xmlEscape(attribution)}</text>` : "";

  const aumid = appId || DEFAULT_AUMID;
  const imageTag = iconUri ? `<image placement="appLogoOverride" src="${xmlEscape(iconUri)}" hint-crop="circle"/>` : "";
  const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
\$xmlText = @'
<toast activationType="protocol" launch="">
  <visual>
    <binding template="ToastGeneric">
      ${imageTag}
      <text>${xmlEscape(title)}</text>
      <text>${xmlEscape(message)}</text>
      ${attributionTag}
    </binding>
  </visual>
  ${audioTag}
</toast>
'@
\$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
\$xml.LoadXml(\$xmlText)
\$toast = New-Object Windows.UI.Notifications.ToastNotification \$xml
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${aumid.replace(/'/g, "''")}').Show(\$toast)
${playBlock}
`;

  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 15000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`toast failed: ${err.message} ${stderr?.slice(0, 300) || ""}`));
        resolve();
      }
    );
  });
}
