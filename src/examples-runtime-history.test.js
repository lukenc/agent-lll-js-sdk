import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

async function text(path) {
  return await readFile(new URL(`../${path}`, import.meta.url), 'utf-8')
}

describe('examples and demo show RuntimeHistory context tracks', () => {
  it('CLI examples demonstrate visible/model/all tracks and artifacts', async () => {
    const basic = await text('examples/basic.js')
    const plan = await text('examples/plan-and-execute.js')

    assert.match(basic, /getHistory\('all'\)/)
    assert.match(basic, /getHistory\('visible'\)/)
    assert.match(basic, /getHistory\('model'\)/)
    assert.match(plan, /getArtifacts\(\)/)
  })

  it('interactive demo exposes RuntimeHistory context snapshots', async () => {
    const server = await text('demo/server.js')
    const indexHtml = await text('demo/index.html')
    const browserHtml = await text('demo/browser.html')
    const readme = await text('demo/README.md')

    assert.match(server, /req\.url === '\/context'/)
    assert.match(server, /getHistory\('all'\)/)
    assert.match(server, /getHistory\('visible'\)/)
    assert.match(server, /getHistory\('model'\)/)
    assert.match(server, /getArtifacts\(\)/)
    assert.match(indexHtml, /renderContextSnapshot/)
    assert.match(browserHtml, /renderBrowserContextSnapshot/)
    assert.match(browserHtml, /getHistory\('all'\)/)
    assert.match(readme, /RuntimeHistory 与上下文轨道/)
  })
})
