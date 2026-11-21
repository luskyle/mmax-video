# MMax Video

调用本机 MiniMax H3 的 Electron 桌面应用。输入提示词，选择视频尺寸，在工作区中
保存生成任务、视频及日志；不在 MiniMax 目录写入应用日志或生成结果。

## 启动

当前电脑已安装项目本地 Node.js 和 Electron，在终端运行：

```bash
cd /home/luskyle/project/mmax-video
bash run.sh
```

也可以在 Linux 应用菜单中搜索 **MMax Video** 启动。

其他环境需先安装 Node.js 22 和 npm，然后在项目目录运行 `npm install`；
Electron 下载受网络影响时可使用
`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm install`。
需要 Linux 图形桌面。应用目前使用本机固定的 MiniMax 安装路径
`/home/luskyle/apps/minimax`，模型和推理器不包含在本项目中。

## 使用

1. 点击「新建工作区」，输入名称并选择**父目录**；应用创建新的工作区文件夹。
   也可以用「打开工作区」选择已有的工作区文件夹。工作区不能在 MiniMax 目录内。
2. 输入提示词，选择尺寸或输入自定义宽高；尺寸必须是 256–1920 的 32 的倍数。
   `-1` 为随机种子。点击「保存默认设置」可保存尺寸和种子，后续打开时恢复。
3. 点击「开始生成」。应用一次只启动一个任务，生成期间不能切换工作区或关闭窗口。
   完成后点击左侧记录预览，可定位视频和日志文件。

每个工作区的 `.mmax-workspace.json` 保存设置；`jobs/<任务编号>/` 保存 `job.json`、
`generation.log`、生成的 `original.webm` 和适合播放器的 `video.webm`。
原始音频为 PCM，应用将视频流直接复制并把音频转换为 Opus，视频不重新编码。
任务失败时日志和可能的部分文件也保留在对应工作区；异常退出后会标记未完成任务，
如果先前的进程仍在运行，则等待其退出后才可继续。

应用使用本机 `generate.sh`、CUDA 和 HyperFlow H3 Flash Q4 模型，固定 6 步、
124 帧、24 fps（约 5 秒）。当前 A2000 12GB 上曾实测 640×384 约 4 分钟、
960×544 约 9 分钟、1088×608 约 12 分钟；高分辨率会增加显存消耗和耗时，
可能失败，并不保证所有尺寸都能运行。模型可能生成错误的文字、数字或运动。
运行期间尽量避免同时从其他程序启动 GPU 推理。视频和音频保留在所选工作区，
应用自身的上次工作区路径由 Electron 存在系统应用设置目录。

## 验证

```bash
PATH="$PWD/.tools/node-v22.23.5-linux-x64/bin:$PATH" npm test
```

模型及推理部署细节和许可证请参阅 `/home/luskyle/apps/minimax/README.md`。
