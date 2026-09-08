// Run with Playwright MCP browser_run_code_unsafe({ filename: <absolute path> }).
// Start the local scripted fixture and demo server first; see the review report.
async (page) => {
  const output = []
  for (const mode of ['node', 'browser']) {
    const errors = []
    const onError = error => errors.push(error.message)
    page.on('pageerror', onError)
    await page.goto(`http://127.0.0.1:3029/${mode === 'browser' ? 'browser' : ''}`)
    await page.waitForLoadState('networkidle')
    if (mode === 'node') {
      await page.getByRole('button', { name: '新会话', exact: true }).click()
    } else {
      await page.locator('#provider').selectOption('openai')
      await page.locator('#model').fill('fixture')
      await page.locator('#apikey').fill('fixture')
      await page.locator('#apiUrl').fill('http://127.0.0.1:4329/v1/chat/completions')
      await page.getByRole('button', { name: '连接', exact: true }).click()
      await page.getByRole('textbox', { name: '输入消息...' }).waitFor()
      await page.evaluate(() => {
        window.reportEvents = []
        window.reportTelemetry = []
        const stream = agent.stream.bind(agent)
        agent.stream = async function* (...args) {
          for await (const event of stream(...args)) { window.reportEvents.push(event); yield event }
        }
        agent.on('tool.call', event => window.reportTelemetry.push(event))
      })
    }
    const response = mode === 'node' ? page.waitForResponse(r => r.url().endsWith('/chat')) : null
    await page.getByRole('textbox', { name: '输入消息...' }).fill('连续调用两次 calculate，参数都是 6*7。')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByText('done: call_AAA=42; call_BBB=42', { exact: true }).waitFor()
    let events, telemetry
    if (response) {
      const text = await (await response).text()
      events = text.split('\n').filter(line => line.startsWith('data:') && line.slice(5).trim() !== '[DONE]').map(line => JSON.parse(line.slice(5)))
    } else {
      events = await page.evaluate(() => window.reportEvents)
      telemetry = await page.evaluate(() => window.reportTelemetry)
    }
    const lifecycle = events.filter(event => ['tool_start', 'tool_end'].includes(event.type))
    if (lifecycle.map(event => event.type).join(',') !== 'tool_start,tool_end,tool_start,tool_end') throw new Error('Unexpected lifecycle order')
    if (lifecycle.some(event => 'toolCallId' in event)) throw new Error('Baseline no longer matches the report')
    const reply = events.find(event => event.type === 'done')
    if (reply?.stopReason !== 'completed') throw new Error('Conversation did not complete')
    await page.getByRole('textbox', { name: '输入消息...' }).fill('上一轮的调用 ID 是什么？')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByText('memory ids: call_AAA,call_BBB', { exact: true }).waitFor()
    await page.screenshot({ path: `/Users/luke/unipus/i-publish/agent-lll-js-sdk/docs/repro/toolcallid/demo-${mode}.png`, fullPage: true })
    if (errors.length) throw new Error(errors.join('\n'))
    output.push({ mode, lifecycle, telemetry, reply, memory: 'passed', errors, text: await page.locator('#chat').innerText() })
    page.off('pageerror', onError)
  }
  return output
}
