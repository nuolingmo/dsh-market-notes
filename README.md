# 插件中文备注（Market Notes）

给 dshmarket 里还没有备注的插件自动写一句人话中文说明，让你在插件卡片上扫一眼就知道它是干嘛的、什么时候用得上。已有备注（尤其是你手写的）一律不动，只填空。

> 需要先安装并启用 [dshmarket](https://www.npmjs.com/package/dshmarket)（备注写在它的数据里）。
>
> GitHub 仓库：<https://github.com/nuolingmo/dsh-market-notes> · 安装包：<https://github.com/nuolingmo/dsh-market-notes/releases>

## 安装

在 DSH 插件页 → 安装插件，输入包名：

```text
dsh-market-notes
```

或使用 CLI：

```sh
dsh plugin --profile web add dsh-market-notes
```

也可以直接从 GitHub 安装：把 Release 里的 `dsh-market-notes-1.0.0.tgz` 下载到本地，在插件页安装框填它的路径；或填 Git 地址 `git+https://github.com/nuolingmo/dsh-market-notes.git`。

安装后 DSH 启动 30 秒内会自动扫一次；也可以打开 **设置 → 通用 → 插件中文备注** 点「立即扫描」。

## 它怎么工作

1. 读取当前 profile 的依赖列表，只挑 dshmarket 里**还没有备注**的插件；
2. 从本地读取每个插件的 `package.json` 描述和 `README*.md` 第一段（缺 README 用描述，都缺则跳过并记录）；
3. 把所有原文**一次性**交给当前默认模型，要求返回 JSON 数组（一次调用，仅对不合规项追加一次修复调用）；
4. 通过 dshmarket 自己的 `POST /dsh-market/note` 接口逐条写回；每个包写入前重新读一次备注，运行中被你手写的备注不会被覆盖；
5. 单个插件失败不影响其他插件，最后汇总生成/跳过/失败数量。

所有插件资料来自本地磁盘，不抓任何目录站点。

## 备注标准

50–120 个汉字（硬上限 200，市场会截断）；前 20 字必须能独立看懂；结构是「它是干什么的 → 你什么时候用得上 →（可选）要注意什么」；用第二人称、说人话，不出现英文包名和 API/peer/bundle 这类术语；句号断句、不换行；禁止营销词。AI 生成的备注带 🤖 前缀，便于和你手写的内容区分。

## 数据与隐私

- 本插件只读本机 profile 依赖、`node_modules` 里的插件描述和 README；
- 只调用本机 dshmarket 的接口写备注；
- 除「把插件描述/README 发给**你自己配置的模型**用于生成备注」外，不向任何外部服务器发送数据；不收集遥测、不写日志到远端；
- 不包含任何账号、密钥或硬编码路径。

## 兼容性

- DSH：`peerDependencies: @deepseek-ai/dsh ^0.2.1-rc.1`（在 0.2.1-rc.2 上验证通过）；
- 平台：Web GUI（客户端半个区只在 Web 端加载；Host 半个区在带 webServer 的 profile 中工作）；
- 生成备注需要已配置可用的默认模型；断网/无模型时扫描会报错退出，不会写坏备注。

## 卸载

插件页关闭或卸载即可。已写入 dshmarket 的备注会保留（可在市场里手动清空）。

## 开发

- Host：[`index.js`](./index.js)（扫描、单次模型调用、校验、写备注）
- Client：[`client/client.js`](./client/client.js)（设置里的「立即扫描」行）
- 临时报告：`%TEMP%\dsh-market-notes\last-run.json`、`last-model-output.txt`
- 接口：`GET /dsh-market-notes/status`、`POST /dsh-market-notes/scan`
