/**
 * 运行时补丁：把 digital_life_dashboard 的校验报错换成可读提示（根因在 L0，无法真正修复）
 * 由数字生命自己通过 write_new_organ 生成于 2026-11-06T05:40:45.095Z
 * 修改这个文件后宿主会自动重新装载（watch self-made/）。
 */
export default defineOrgan({
  manifest: {
    name: 'dashboard-fix',
    version: '1.1.0',
    capabilities: ['patch:runtime'],
    patches: [
      { target: 'digital_life_dashboard', phase: 'after' },
    ],
  },

  onLoad(ctx) {
    ctx.log('info', '已装载：digital_life_dashboard 的报错会被换成可读提示')
  },

  // 器官契约要求的两个回调，缺了每轮都会报错
  getPromptContext() {
    return ''
  },

  feedback() {
    return {}
  },

  /**
   * 这个 bug 从器官层修不了。
   *
   * 根因：核心把 digital_life_dashboard 注册成 output schema additionalProperties:false，
   * 但返回值里带了 restMode / naturalCap 两个没声明的字段，校验器把整条结果拒掉。
   *
   * 为什么补不了：核心工具的 after 补丁挂在 tools/post-execute 上，那时校验已经做完了，
   * 而且那条链只允许替换 content 文本，不允许替换 value。器官工具才有 execute 外层可改。
   *
   * 所以这里只做一件事：把报错换成一句能看懂的，并在里面写清楚真正的原因和绕过办法。
   */
  hook(input) {
    if (!input || input.tool !== 'digital_life_dashboard') return { kind: 'pass' }
    if (input.phase !== 'after') return { kind: 'pass' }
    const text = String(input.result?.text ?? '')
    if (text.indexOf('restMode') < 0 && text.indexOf('naturalCap') < 0) return { kind: 'pass' }
    return {
      result: {
        text: 'digital_life_dashboard 暂时不可用。原因是核心把它的 output schema 写死了'
          + '（additionalProperties: false），但返回值里多带了 restMode 和 naturalCap 两个未声明的字段，'
          + '校验器于是把整条结果拒掉。这不是数据出错，是声明漏了两个字段。'
          + '要活体征，改用 digital_life_status，那个是正常的。',
      },
      note: 'dashboard 报错已换成可读提示',
    }
  },
})

