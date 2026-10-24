// Toast 通知（PowerShell + WinRT 自实现，替代 powertoast/powerballoon）
import { execFile } from "node:child_process";
import path from "node:path";
import { exists } from "../../shared/fsx.js";
import { log } from "../../shared/log.js";
import { resolveSound } from "../../core/config.js";

const DEFAULT_AUMID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

function xmlEscape(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function sendToast({ title, message, icon, appId, sound, attribution }) {
  let iconUri = "";
  if (icon && /^https?:/.test(icon)) {
    // http 图标 WinRT 不收，调用方应先 prefetch 成本地路径；此处兜底忽略
    iconUri = "";
  } else if (icon && (await exists(icon))) {
    iconUri = "file:///" + path.resolve(icon).replace(/\\/g, "/");
  }

  // 音效：default=系统默认；silent=静音；system:XXX=系统音；wav 路径=静音 Toast + 自己播放（支持任意音频）
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
      playBlock = `
Add-Type -AssemblyName presentationCore
$player = New-Object System.Windows.Media.MediaPlayer
$player.Open([Uri]"${snd.path.replace(/\\/g, "/")}")
Start-Sleep -Milliseconds 300
$player.Play()
`;
    } else {
      log.warn(`[TOAST] 自定义音效文件不存在: ${snd.path}，改用系统默认`);
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
