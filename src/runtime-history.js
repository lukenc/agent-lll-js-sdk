const BUILTIN_TRACKS = new Set(['all', 'visible', 'model', 'artifacts', 'internal'])

function clonePlain(value) {
  if (value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(clonePlain)
  const out = Object.create(Object.getPrototypeOf(value))
  for (const key of Object.keys(value)) out[key] = clonePlain(value[key])
  return out
}

function defaultMessageTracks(message) {
  const tracks = new Set(['all', 'model'])
  if (
    message
    && (message.role === 'user'
      || (message.role === 'assistant' && !Array.isArray(message.tool_calls)))
  ) {
    tracks.add('visible')
  }
  return [...tracks]
}

function isSummaryMessage(message) {
  return message?.role === 'system' && message._isSummary === true
}

function summaryMessage(content) {
  return {
    role: 'system',
    content: `[Previous conversation summary]: ${content}`,
    _isSummary: true,
  }
}

export class RuntimeHistory {
  constructor(options = {}) {
    this.events = []
    this.tracks = new Map()
    this._nextId = 1
    this._now = typeof options.now === 'function' ? options.now : () => Date.now()
    this._activeTopicId = options.activeTopicId ?? 'default'
  }

  setActiveTopic(topicId) {
    if (typeof topicId !== 'string' || topicId.length === 0) {
      throw new TypeError('setActiveTopic: topicId must be a non-empty string')
    }
    this._activeTopicId = topicId
  }

  getActiveTopic() {
    return this._activeTopicId
  }

  append(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new TypeError('append: event must be an object')
    }
    const tracks = new Set(Array.isArray(event.tracks) ? event.tracks : [])
    tracks.add('all')
    const normalized = {
      ...clonePlain(event),
      id: event.id ?? `evt_${this._nextId++}`,
      timestamp: event.timestamp ?? this._now(),
      topicId: event.topicId ?? this._activeTopicId,
      parentTopicId: event.parentTopicId ?? null,
      tracks: [...tracks],
      meta: clonePlain(event.meta ?? {}),
    }
    this.events.push(normalized)
    return clonePlain(normalized)
  }

  appendMessage(message, meta = {}) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      throw new TypeError('appendMessage: message must be an object')
    }
    if (isSummaryMessage(message)) {
      return this.appendSummary({
        content: String(message.content ?? '').replace(/^\[Previous conversation summary\]:\s*/, ''),
        sourceEventIds: meta.sourceEventIds ?? [],
        topicId: meta.topicId,
      })
    }
    return this.append({
      type: 'message',
      message: clonePlain(message),
      tracks: meta.tracks ?? defaultMessageTracks(message),
      topicId: meta.topicId,
      parentTopicId: meta.parentTopicId,
      meta,
    })
  }

  appendArtifact(artifact) {
    return this.append({
      type: 'artifact',
      artifact: clonePlain(artifact),
      tracks: ['all', 'artifacts'],
    })
  }

  appendSummary(summary) {
    return this.append({
      type: 'summary',
      content: summary.content ?? '',
      sourceEventIds: Array.isArray(summary.sourceEventIds) ? [...summary.sourceEventIds] : [],
      tracks: summary.tracks ?? ['all', 'model', 'internal'],
      topicId: summary.topicId,
      parentTopicId: summary.parentTopicId,
      meta: summary.meta ?? {},
    })
  }

  registerTrack(name, definition = {}) {
    assertTrackName(name, 'registerTrack')
    if (BUILTIN_TRACKS.has(name)) {
      throw new Error(`registerTrack: "${name}" is a built-in track and cannot be overwritten`)
    }
    this.tracks.set(name, {
      description: definition.description ?? '',
      include: typeof definition.include === 'function' ? definition.include : null,
    })
  }

  unregisterTrack(name) {
    assertTrackName(name, 'unregisterTrack')
    if (BUILTIN_TRACKS.has(name)) return false
    return this.tracks.delete(name)
  }

  listTracks() {
    return [...BUILTIN_TRACKS, ...this.tracks.keys()]
  }

  clear() {
    this.events = []
    this._nextId = 1
  }

  getEvents(trackName = 'all') {
    return this._eventsForTrack(trackName).map(clonePlain)
  }

  project(trackName = 'all', options = {}) {
    if (trackName === 'model' || trackName === 'visible') {
      return this.projectMessages(trackName, options)
    }
    if (trackName === 'artifacts') {
      return this._eventsForTrack('artifacts').map(event => {
        if (event.type === 'artifact') return clonePlain(event.artifact)
        return clonePlain(event)
      })
    }
    return this.getEvents(trackName)
  }

  projectMessages(trackName = 'model', options = {}) {
    const topicId = options.topicId ?? (trackName === 'model' ? this._activeTopicId : null)
    const events = this._eventsForTrack(trackName)
      .filter(event => topicId == null || event.topicId === topicId)

    const latestSummary = [...events].reverse().find(event => event.type === 'summary')
    const covered = new Set(latestSummary?.sourceEventIds ?? [])
    const out = []

    if (options.includeSummary !== false && latestSummary) {
      out.push(summaryMessage(latestSummary.content ?? ''))
    }

    for (const event of events) {
      if (event.type !== 'message') continue
      if (covered.has(event.id)) continue
      out.push(clonePlain(event.message))
    }
    return out
  }

  rebuildFromMessages(messages) {
    if (!Array.isArray(messages)) {
      throw new TypeError('rebuildFromMessages: messages must be an array')
    }
    this.clear()
    for (const message of messages) this.appendMessage(message)
  }

  get size() {
    return this.events.length
  }

  _eventsForTrack(trackName) {
    if (trackName === 'all') return this.events
    if (BUILTIN_TRACKS.has(trackName)) {
      return this.events.filter(event => event.tracks.includes(trackName))
    }
    const custom = this.tracks.get(trackName)
    if (!custom) {
      return this.events.filter(event => event.tracks.includes(trackName))
    }
    return this.events.filter(event =>
      event.tracks.includes(trackName) || (custom.include && custom.include(event))
    )
  }
}

function assertTrackName(name, apiName) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new TypeError(`${apiName}: track name must be a non-empty string`)
  }
}
