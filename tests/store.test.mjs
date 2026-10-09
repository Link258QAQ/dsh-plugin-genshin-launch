// 插件自有配置存储 + 宿主侧问答通道的自测（零依赖，Node >= 20）
//   node tests/store.test.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createQuestionHub } from '../lib/questions.js'
import { FACTORY_SIZE_BASELINE, defaultStore, normalizeStore, openStore, resolveSizeBaseline } from '../lib/store.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-genshin-store-'))

try {
  // ------------------------------------------------------------ 配置文件（v2：路径加密）
  const file = join(dir, 'config.json')
  const store = openStore(file)
  assert.equal(store.get().scanConsent, 'unset', '默认还没问过扫盘')
  assert.equal(store.get().sizeBaselineBytes, 0)

  // 出厂结构：不再有 scanFoundExe 这个冗余字段。
  assert.ok(!('scanFoundExe' in defaultStore()), 'v2 默认结构不应再带 scanFoundExe')

  // 写入会落盘，但**路径不以任何字段名直接出现在明文 JSON 里**。
  store.patch({ gameExe: 'D:\\youxi\\YuanShen.exe' })
  assert.ok(existsSync(file), 'patch 之后文件应该存在')
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(onDisk.version, 2)
  assert.equal(onDisk.gameExe, undefined, '明文 gameExe 字段不应出现在盘上')
  assert.equal(onDisk.gamePath, undefined, '明文 gamePath 字段不应出现在盘上')
  assert.ok(typeof onDisk.secrets === 'string' && onDisk.secrets, '路径应落在 secrets 里')
  assert.ok(['dpapi', 'plain'].includes(onDisk.encryption), '应标出存储方式（DPAPI 可用=dpapi / 不可用=plain）')
  // DPAPI 可用时 secrets 一定带前缀且看不到原文；不可用（受限沙箱）时是明文 JSON——
  // 这是文档化的降级，不该在加密模式下泄露原文。
  if (onDisk.encryption === 'dpapi') {
    assert.ok(onDisk.secrets.startsWith('enc:v1:'), 'dpapi 模式 secrets 要带前缀')
    assert.ok(!onDisk.secrets.includes('YuanShen'), 'dpapi 模式盘上看不到原路径')
  } else {
    assert.ok(onDisk.secrets.includes('YuanShen'), 'plain 降级模式里 secrets 就是明文（可接受）')
  }
  assert.ok(onDisk.updatedAt, '应该记下更新时间')

  // 重新打开能读回来（解密/解包由 store 内部完成）。
  const reopened = openStore(file)
  assert.equal(reopened.get().gameExe, 'D:\\youxi\\YuanShen.exe')

  // security() 报告存储方式。
  assert.equal(store.security().encryption, onDisk.encryption)

  // 坏文件不炸，按出厂值兜底
  writeFileSync(file, '{ 这不是 JSON', 'utf8')
  const broken = openStore(file)
  assert.equal(broken.get().gameExe, '', '坏文件按出厂值跑')

  // 手改坏的字段要被规整
  const messy = normalizeStore({
    gameExe: 123,
    gamePath: '  C:\\games\\Genshin Impact  ',
    scanConsent: '随便写的',
    scanDone: 'yes',
    sizeBaselineBytes: -5,
  })
  assert.equal(messy.gameExe, '', '非字符串丢掉')
  assert.equal(messy.gamePath, 'C:\\games\\Genshin Impact', 'trim 掉空白')
  assert.equal(messy.scanConsent, 'unset', '非法枚举回到 unset')
  assert.equal(messy.scanDone, false, '非布尔回到 false')
  assert.equal(messy.sizeBaselineBytes, 0, '负数回到 0')
  assert.deepEqual(Object.keys(defaultStore()).sort(), Object.keys(messy).sort(), '规整后的字段集合应该和出厂一致')

  // 老版本（v1）明文文件：打开时自动迁移，scanFoundExe 并进 gameExe，明文路径被加密重写。
  writeFileSync(
    file,
    JSON.stringify({ gamePath: 'D:\\games\\Genshin Impact', scanConsent: 'denied', scanDone: true, scanFoundExe: '', sizeBaselineBytes: 234381736 }),
    'utf8',
  )
  const migrated = openStore(file)
  assert.equal(migrated.get().scanConsent, 'denied')
  assert.equal(migrated.get().sizeBaselineBytes, 234381736)
  assert.equal(migrated.get().gamePath, 'D:\\games\\Genshin Impact')
  const afterMigrate = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(afterMigrate.version, 2, 'v1 文件应被升级成 v2')
  assert.equal(afterMigrate.gameExe, undefined, '迁移后明文 gameExe 不该残留')
  assert.equal(afterMigrate.gamePath, undefined, '迁移后明文 gamePath 不该残留')

  // v1 里只有 scanFoundExe（没有手填）：迁移时并进 gameExe。
  writeFileSync(file, JSON.stringify({ scanFoundExe: 'E:\\Genshin\\YuanShen.exe', scanDone: true }), 'utf8')
  const fromScan = openStore(file)
  assert.equal(fromScan.get().gameExe, 'E:\\Genshin\\YuanShen.exe', '老的 scanFoundExe 应并进 gameExe')

  // ------------------------------------------------------------ 体积基准
  assert.equal(resolveSizeBaseline({}).source, 'factory', '没学过就用出厂值')
  assert.equal(resolveSizeBaseline({}).bytes, FACTORY_SIZE_BASELINE)
  const learned = resolveSizeBaseline({ sizeBaselineBytes: 240000000, sizeBaselineAt: 'x', sizeBaselineUrl: 'y' })
  assert.equal(learned.source, 'learned', '学过就用学到的')
  assert.equal(learned.bytes, 240000000)
  assert.equal(learned.url, 'y')

  // ------------------------------------------------------------ 问答通道
  const hub = createQuestionHub({ timeoutMs: 0, onNote: () => {} })
  assert.equal(hub.view(), undefined, '一开始没有问题')

  const asked = hub.ask({
    kind: 'scan-consent',
    title: '要不要扫盘？',
    lines: ['只列目录名', '不联网'],
    options: [
      { id: 'allow', label: '继续' },
      { id: 'deny', label: '拒绝' },
    ],
    defaultOption: 'deny',
  })
  const view = hub.view()
  assert.equal(view.kind, 'scan-consent')
  assert.equal(view.lines.length, 2)
  assert.equal(view.options.length, 2)

  // 错 id / 错选项都不该被接受
  assert.equal(hub.answer('不存在的 id', 'allow'), false)
  assert.equal(hub.answer(view.id, '不存在的选项'), false)
  assert.equal(hub.answer(view.id, 'allow'), true)
  assert.equal(await asked, 'allow', '回答要传到等的人手里')
  assert.equal(hub.view(), undefined, '答完就清空')

  // 超时按 defaultOption 收场（这里 timeoutMs 传 0 表示不超时，所以单独造一个）
  const shortHub = createQuestionHub({ timeoutMs: 20, onNote: () => {} })
  const shortAsked = shortHub.ask({
    kind: 'size-baseline',
    title: '信任吗？',
    options: [
      { id: 'trust', label: '信任' },
      { id: 'reject', label: '拒绝' },
    ],
    defaultOption: 'reject',
  })
  assert.equal(await shortAsked, 'reject', '没人回答时按最保守的选项收场')

  // 新问题顶掉旧问题时，旧问题也按自己的 defaultOption 收场
  const hub2 = createQuestionHub({ timeoutMs: 0, onNote: () => {} })
  const first = hub2.ask({ kind: 'a', title: 'A', options: [{ id: 'x', label: 'x' }], defaultOption: 'x' })
  const second = hub2.ask({ kind: 'b', title: 'B', options: [{ id: 'y', label: 'y' }], defaultOption: 'y' })
  assert.equal(await first, 'x', '被顶掉的旧问题按自己的 defaultOption 收场')
  assert.equal(hub2.view().kind, 'b', '新问题成为当前问题')
  assert.equal(hub2.answer(hub2.view().id, 'y'), true)
  assert.equal(await second, 'y')

  // 卸载时把所有挂着的问题放掉
  const hub3 = createQuestionHub({ timeoutMs: 0, onNote: () => {} })
  const hanging = hub3.ask({ kind: 'c', title: 'C', options: [{ id: 'no', label: 'no' }], defaultOption: 'no' })
  hub3.cancelAll('测试收尾')
  assert.equal(await hanging, 'no')
  assert.equal(hub3.view(), undefined)

  console.log('配置存储 / 问答通道自测通过：坏文件兜底、字段规整、基准优先级、超时按保守选项收场。')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
