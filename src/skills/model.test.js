import { test } from 'node:test'
import assert from 'node:assert'
import { parseFrontmatter, parseSkillMd, applySkillArgs } from './model.js'
import { SkillParseError } from './errors.js'

test('parseFrontmatter splits block and body', () => {
  const text = '---\nname: pdf\ndescription: Process PDFs\n---\nBody line one\nBody line two'
  const { frontmatter, body } = parseFrontmatter(text)
  assert.strictEqual(frontmatter.name, 'pdf')
  assert.strictEqual(frontmatter.description, 'Process PDFs')
  assert.strictEqual(body, 'Body line one\nBody line two')
})

test('parseFrontmatter with no frontmatter returns empty map + full body', () => {
  const { frontmatter, body } = parseFrontmatter('just text')
  assert.deepStrictEqual(frontmatter, {})
  assert.strictEqual(body, 'just text')
})

test('parseFrontmatter parses string list (block + inline)', () => {
  const block = '---\nallowed-tools:\n  - read_file\n  - shell_exec\n---\nx'
  assert.deepStrictEqual(parseFrontmatter(block).frontmatter['allowed-tools'], ['read_file', 'shell_exec'])
  const inline = '---\nallowed-tools: read_file, shell_exec\n---\nx'
  assert.deepStrictEqual(parseFrontmatter(inline).frontmatter['allowed-tools'], ['read_file', 'shell_exec'])
})

test('parseSkillMd builds a valid Skill_Def', () => {
  const text = '---\nname: pdf-processing\ndescription: Process PDFs\nversion: 1.0.0\n---\nInstructions here'
  const def = parseSkillMd(text, {
    dirName: 'pdf-processing',
    source: { provider: 'local', origin: '/skills' },
    files: ['scripts/fill.py'],
    baseDir: '/skills/pdf-processing',
  })
  assert.strictEqual(def.name, 'pdf-processing')
  assert.strictEqual(def.description, 'Process PDFs')
  assert.strictEqual(def.version, '1.0.0')
  assert.strictEqual(def.body, 'Instructions here')
  assert.deepStrictEqual(def.files, ['scripts/fill.py'])
  assert.strictEqual(def.baseDir, '/skills/pdf-processing')
  assert.strictEqual(def.disableModelInvocation, false)
})

test('parseSkillMd uses dirName over frontmatter name on mismatch', () => {
  const text = '---\nname: wrong-name\ndescription: d\n---\nb'
  const def = parseSkillMd(text, { dirName: 'real-name', source: {}, files: [], baseDir: null })
  assert.strictEqual(def.name, 'real-name')
})

test('parseSkillMd throws on missing description', () => {
  const text = '---\nname: pdf\n---\nb'
  assert.throws(
    () => parseSkillMd(text, { dirName: 'pdf', source: {}, files: [], baseDir: null }),
    SkillParseError,
  )
})

test('parseSkillMd truncates over-long description to 1024', () => {
  const long = 'x'.repeat(2000)
  const text = `---\nname: pdf\ndescription: ${long}\n---\nb`
  const def = parseSkillMd(text, { dirName: 'pdf', source: {}, files: [], baseDir: null })
  assert.strictEqual(def.description.length, 1024)
})

test('parseSkillMd preserves unknown fields in metadata.extra', () => {
  const text = '---\nname: pdf\ndescription: d\ncustom-field: hello\n---\nb'
  const def = parseSkillMd(text, { dirName: 'pdf', source: {}, files: [], baseDir: null })
  assert.strictEqual(def.metadata.extra['custom-field'], 'hello')
})

test('parseSkillMd parses disable-model-invocation true', () => {
  const text = '---\nname: pdf\ndescription: d\ndisable-model-invocation: true\n---\nb'
  const def = parseSkillMd(text, { dirName: 'pdf', source: {}, files: [], baseDir: null })
  assert.strictEqual(def.disableModelInvocation, true)
})

test('parseSkillMd preserves commas in description (regression)', () => {
  const text = '---\nname: pdf\ndescription: Create new skills, modify and improve existing skills\n---\nb'
  const def = parseSkillMd(text, { dirName: 'pdf', source: {}, files: [], baseDir: null })
  assert.strictEqual(def.description, 'Create new skills, modify and improve existing skills')
  assert.strictEqual(typeof def.description, 'string')
})

test('parseSkillMd exposes argument-hint as argumentHint (null when absent)', () => {
  const withHint = '---\nname: pdf\ndescription: d\nargument-hint: [pr-number] [priority]\n---\nb'
  const def = parseSkillMd(withHint, { dirName: 'pdf', source: {}, files: [], baseDir: null })
  assert.strictEqual(def.argumentHint, '[pr-number] [priority]')
  // known key => not leaked into metadata.extra
  assert.strictEqual(def.metadata.extra['argument-hint'], undefined)

  const without = '---\nname: pdf\ndescription: d\n---\nb'
  const bare = parseSkillMd(without, { dirName: 'pdf', source: {}, files: [], baseDir: null })
  assert.strictEqual(bare.argumentHint, null)
})

test('applySkillArgs substitutes $ARGUMENTS and $1..$9', () => {
  const body = 'Review PR #$1 at priority $2, assign $3.\nAll: $ARGUMENTS'
  const { text, applied } = applySkillArgs(body, '123 high alice')
  assert.strictEqual(applied, true)
  assert.match(text, /Review PR #123 at priority high, assign alice\./)
  assert.match(text, /All: 123 high alice/)
})

test('applySkillArgs fills missing positionals with empty string', () => {
  const { text } = applySkillArgs('a=$1 b=$2 c=$3', 'only')
  assert.strictEqual(text, 'a=only b= c=')
})

test('applySkillArgs leaves placeholders empty when no args given', () => {
  const { text, applied } = applySkillArgs('x=$1 all=$ARGUMENTS', '')
  assert.strictEqual(text, 'x= all=')
  assert.strictEqual(applied, true) // placeholders consumed the (empty) args
})

test('applySkillArgs reports applied=false when body has no placeholders', () => {
  const { text, applied } = applySkillArgs('no placeholders here', 'a b')
  assert.strictEqual(text, 'no placeholders here')
  assert.strictEqual(applied, false)
})

test('applySkillArgs treats missing/nullish args as empty', () => {
  assert.strictEqual(applySkillArgs('x=$1', undefined).text, 'x=')
  assert.strictEqual(applySkillArgs('plain', null).text, 'plain')
})

test('applySkillArgs collapses whitespace runs when splitting positionals', () => {
  const { text } = applySkillArgs('[$1][$2]', '  a \t  b  ')
  assert.strictEqual(text, '[a][b]')
})

test('applySkillArgs does not touch $0 or $10 second digit (only $1..$9)', () => {
  const { text } = applySkillArgs('$0 $10', 'a b')
  assert.strictEqual(text, '$0 a0')
})
