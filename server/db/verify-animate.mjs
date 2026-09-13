// What an eight-way animation does when one of the eight fails, with no api key and nothing bought.

//   node server/db/verify-animate.mjs

// An eight-way ask is eight background jobs, each paid for on its own. The question this file exists to
// settle is what happens to the seven that drew when the eighth does not, because the answer used to be
// "they are abandoned" and the person saw two and a half minutes of waiting and no frames.
//
// awaitAnimation takes its two readers as options, so every case below runs against a scripted account
// rather than a real one. Nothing here touches the network.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { awaitAnimation } from '../pixellab.mjs'

let bad = 0
const ok = (m) => console.log(`  ok    ${m}`)
const no = (m) => {
  bad++
  console.log(`  FAIL  ${m}`)
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const EIGHT = ['south', 'north', 'east', 'west', 'south-east', 'south-west', 'north-east', 'north-west']

/* an account that draws the headings it was told to draw and fails the rest. Frame urls carry the group
 * name so `known` can tell them from whatever the character already had. */
function account({ draws, group = 'motion-test', failWith = 'content policy' }) {
  const jobs = {}
  EIGHT.forEach((dir, i) => {
    jobs['job-' + i] = draws.includes(dir) ? { state: 'done' } : { state: 'failed', error: failWith }
  })
  return {
    jobIds: Object.keys(jobs),
    readJob: async (id) => jobs[id] || { state: 'running' },
    readDetail: async () => ({
      animations: [
        {
          display_name: group,
          directions: draws.map((dir) => ({ direction: dir, frames: [`${group}/${dir}/0.png`, `${group}/${dir}/1.png`] })),
        },
      ],
    }),
  }
}

const handleFor = (acc, group = 'motion-test') => ({
  templateAnimationId: group,
  directions: EIGHT,
  jobIds: acc.jobIds,
})

// the character already had a standing rotation, which is what `known` holds
const KNOWN = new Set(EIGHT.map((d) => `rotation/${d}.png`))

const run = (acc, opts = {}) =>
  awaitAnimation('char-1', handleFor(acc), {
    known: KNOWN,
    every: 1,
    timeoutMs: 400,
    readDetail: acc.readDetail,
    readJob: acc.readJob,
    ...opts,
  })

const dirsOf = (detail) => (detail.animations[0].directions || []).map((d) => d.direction)

try {
  // ---- the reported failure, exactly ---------------------------------------
  // Seven headings drew and one did not. Before this was fixed the wait threw on
  // the first failed job and every one of the seven was abandoned.
  {
    const drew = EIGHT.filter((d) => d !== 'north-west')
    const notes = []
    let detail = null
    let threw = ''
    try {
      detail = await run(account({ draws: drew }), { notes })
    } catch (e) {
      threw = String(e.message || e)
    }
    threw
      ? no(`seven of eight drew and the wait still threw: ${threw}`)
      : ok('seven headings drew and one failed, and the wait hands back the seven')
    detail && dirsOf(detail).length === 7
      ? ok('all seven are in what comes back, so nothing paid for is dropped')
      : no(`came back with ${detail ? dirsOf(detail).length : 0} headings`)
    notes.length === 1 && notes[0].includes('content policy')
      ? ok('and the reason the eighth failed is reported rather than swallowed')
      : no(`the failure reason did not reach the caller: ${JSON.stringify(notes)}`)
  }

  // ---- the floor -----------------------------------------------------------
  // Four is the same floor the library holds a view set to, and it is enforced
  // downstream in newGroupDirs rather than here, so the wait still hands back
  // what it has and lets that one refuse.
  {
    const notes = []
    const detail = await run(account({ draws: ['south', 'north', 'east', 'west'] }), { notes })
    dirsOf(detail).length === 4
      ? ok('four drew and four come back, which is the floor a view set holds to')
      : no(`four drew but ${dirsOf(detail).length} came back`)
    notes.length === 4 ? ok('with all four failures named') : no(`${notes.length} failures reported, expected 4`)
  }

  // ---- one heading, seven dead --------------------------------------------
  {
    const detail = await run(account({ draws: ['south'] }))
    dirsOf(detail).length === 1
      ? ok('one heading alone still comes back, for newGroupDirs to refuse on its own terms')
      : no('a single heading was lost')
  }

  // ---- nothing drew at all -------------------------------------------------
  // This is the only shape that should throw, and it has to carry the reason
  // pixellab gave rather than a message this file invented.
  {
    let threw = ''
    try {
      await run(account({ draws: [], failWith: 'the canvas is not divisible by two' }))
    } catch (e) {
      threw = String(e.message || e)
    }
    threw.includes('divisible by two')
      ? ok('every job failing throws, and says what pixellab said')
      : no(`a total failure answered "${threw}"`)
  }

  // ---- a full set is not slowed down by any of this ------------------------
  {
    const t0 = Date.now()
    const detail = await run(account({ draws: EIGHT }))
    dirsOf(detail).length === 8 ? ok('a clean eight-way run returns all eight') : no('a clean run lost headings')
    // the poll only reads jobs every sixth tick, so a run that is ready on the
    // first read must never have asked about a job at all
    Date.now() - t0 < 200 ? ok('and returns on the first read without polling a single job') : no('a clean run waited for the job poll')
  }

  // ---- a job that never settles is still a timeout -------------------------
  // Narrowing what the wait holds out for must not turn a hung job into a silent
  // success: with one still running there is a heading that may yet arrive.
  {
    const acc = account({ draws: ['south', 'north', 'east'] })
    const stuck = { ...acc, readJob: async (id) => (id === 'job-7' ? { state: 'running' } : acc.readJob(id)) }
    let threw = ''
    try {
      await run(stuck)
    } catch (e) {
      threw = String(e.message || e)
    }
    threw.includes('timed out')
      ? ok('a job still running holds the wait open to its own deadline')
      : no(`a running job did not hold the wait: "${threw}"`)
  }

  // ---- a reader that blinks is not a failure -------------------------------
  {
    const acc = account({ draws: EIGHT })
    let calls = 0
    const flaky = {
      ...acc,
      readDetail: async () => {
        if (++calls <= 2) throw new Error('502 from the cdn')
        return acc.readDetail()
      },
    }
    const detail = await run(flaky)
    dirsOf(detail).length === 8 ? ok('two failed reads in a row are ridden out rather than thrown') : no('a blinking read lost the run')
  }

  // ---- three failed reads IS a failure -------------------------------------
  {
    let threw = ''
    try {
      await run({ ...account({ draws: EIGHT }), readDetail: async () => { throw new Error('network down') } })
    } catch (e) {
      threw = String(e.message || e)
    }
    threw.includes('network down') ? ok('and three in a row still gives up, carrying the real error') : no(`three bad reads answered "${threw}"`)
  }
} catch (e) {
  no('the checks themselves threw: ' + String(e && e.stack ? e.stack.split('\n')[0] : e))
}

// ---- a still that becomes an animation -------------------------------------
// The other half of animating, and the one with no character in it: an ordinary
// asset is one png, and animating it replaces that png with a folder of frames
// under the same name. Two things have to follow it across, and each failed.
{
  const ts = (await import('typescript')).default
  const src = fs.readFileSync(path.join(ROOT, 'src/core/editor.ts'), 'utf8')
  const cut = src.slice(src.indexOf('export function itemMatch'), src.indexOf('export class Editor'))
  const js = ts.transpileModule(cut, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const { itemMatch, placementIsOf } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

  const LIB = '/work/a-map/library/'
  const still = LIB + 'palm.png'
  const animated = { kind: 'animated', frames: [LIB + 'palm/0.png', LIB + 'palm/1.png'], fps: 6 }
  const m = itemMatch(animated)

  m.key === LIB + 'palm/' ? ok('an animated item is keyed on the folder its frames live in') : no(`the key is ${m.key}`)
  m.wasStill === still ? ok('and it knows the still it replaced, derived off that folder') : no(`the still was read as ${m.wasStill}`)

  /* THE PLACEMENT THAT WAS ALREADY ON THE MAP. It went down while the item was
   * one png, so it is static and holds that url. The png is deleted moments
   * after the frames land, so a placement that does not follow points at
   * nothing: it draws nothing, and reloading does not help, because the dead url
   * is what was saved into the document. */
  placementIsOf({ kind: 'static', src: still }, m)
    ? ok('a placement put down before the animation is recognised as the same thing')
    : no('a placement of the old still was not matched, so it would keep a url with no file under it')

  placementIsOf({ kind: 'animated', frames: [LIB + 'palm/0.png'] }, m)
    ? ok('and so is one placed after it, by its frames')
    : no('an animated placement was not matched')

  /* nothing else may be swept up with it: `palm` and `palm-trimmed` share a
   * prefix, and an in-place edit leaves both in the library */
  !placementIsOf({ kind: 'static', src: LIB + 'palm-trimmed.png' }, m)
    ? ok('while a different item whose name starts the same is left alone')
    : no('palm-trimmed was matched as palm')
  !placementIsOf({ kind: 'animated', frames: [LIB + 'palm-trimmed/0.png'] }, m)
    ? ok('and so is its animated form')
    : no('an animated palm-trimmed was matched as palm')

  const s = itemMatch({ kind: 'static', src: still })
  s.wasStill === '' ? ok('a still item derives no folder, having none') : no('a still invented a folder')
  placementIsOf({ kind: 'static', src: still }, s) ? ok('and matches its own placements') : no('a still did not match itself')

  !placementIsOf({ kind: 'static', src: still }, itemMatch({ kind: 'animated', frames: [] }))
    ? ok('and an item with no frames matches nothing rather than every placement on the map')
    : no('an item with no frames swept up a placement')
}

console.log(bad ? `\n${bad} problem(s).` : '\na heading that fails costs that heading and nothing else.')
process.exit(bad ? 1 : 0)
