/* THE HELP PANEL, as a LIST rather than a tour: six sections matching the six steps, every entry one thing you can do. Everything in it was checked against the code, because help describing a button nobody can find is worse than none. */
import { useState } from 'react'

export interface HelpEntry {
  /* what it is called, in the words the button uses */
  what: string
  /* one line, read at a glance while scanning the list */
  gist: string
  /* the presses in order. Short lines; a step that needs a paragraph is two
   * steps that have not been separated yet. */
  how: string[]
  /* the part worth knowing that is not obvious from the steps. Optional on
   * purpose: most entries do not have one, and inventing them is padding. */
  note?: string
}

export interface HelpSection {
  id: string
  n: number
  name: string
  gist: string
  items: HelpEntry[]
}

export const HELP: HelpSection[] = [
  {
    id: 'load',
    n: 1,
    name: 'load',
    gist: 'Get one whole painting onto the canvas. Every map starts here and every map is one picture.',
    items: [
      {
        what: 'open a painting you already have',
        gist: 'Any png becomes a map.',
        how: [
          'Press "or open one" and pick the file, or drag the png straight onto the canvas.',
          'Give it an id in the address bar: ?img=/hub-final.png&id=hub',
        ],
        note:
          'The id matters more than it looks. Without one the scene is named after the file you dropped, and you land in an empty scene with none of the work you did last time. Same id, same map.',
      },
      {
        what: 'generate a painting',
        gist: 'Describe a map and PixelLab paints the whole thing at once.',
        how: [
          'Type what the place is into "describe the map".',
          'Press generate and wait. It draws several so you have something to choose between.',
          'Press "pick one" and the one you choose becomes the map.',
        ],
        note:
          'A painting cannot be regrown or patched later. If a third of it is wrong the answer is another painting, not an edit, so it is worth reading all of them before you settle.',
      },
    ],
  },
  {
    id: 'cut',
    n: 2,
    name: 'cut',
    gist:
      'Take the sea out. The engine draws its own animated ocean underneath, so the painting needs a transparent edge where the water was.',
    items: [
      {
        what: 'remove ocean',
        gist: 'One press that finds the water and takes it out.',
        how: ['Press "remove ocean".', 'Look at the coastline and fix what it missed with the cut brush.'],
        note: 'It gets most of it and never all of it, so expect to finish the coastline by hand.',
      },
      {
        what: 'remove specks',
        gist: 'Clears the stray pixels left floating off the coast.',
        how: ['Press "remove specks" after any big cut.'],
      },
      {
        what: 'shave fringe',
        gist: 'Takes off the halo of half-transparent pixels around the edge.',
        how: ['Press "shave fringe" once the shape is right.'],
        note:
          'Worth doing last. A fringe reads as a pale outline against the ocean, which is the thing that makes a cut island look pasted on.',
      },
      {
        what: 'cut by colour',
        gist: 'Removes everything close to the colour you click, with a tolerance you set.',
        how: [
          'Choose "cut by colour".',
          'Drag the tolerance up or down.',
          'Click a patch of the colour you want gone.',
        ],
        note:
          'Tolerance too high eats the beach as well as the water. Start low and click again rather than starting high.',
      },
      {
        what: 'cut brush and restore brush',
        gist: 'Erase by hand, and put back anything you took by mistake.',
        how: [
          'Pick "cut brush" and paint over what should go.',
          'Pick "restore brush" and paint to bring it back.',
          'Change the size with the brush slider.',
        ],
        note: 'This is where the coastline actually gets decided. The automatic passes are there to save you the boring half of it.',
      },
      {
        what: 'cut outline',
        gist: 'Draw a polygon and take out everything inside it.',
        how: ['Pick "cut outline".', 'Click each corner around the area.', 'Close the shape to cut it.'],
      },
    ],
  },
  {
    id: 'levels',
    n: 3,
    name: 'levels',
    gist:
      'Paint where a person can walk and how high the ground is. This is per pixel and there is no tile grid, so it can follow anything the painting does.',
    items: [
      {
        what: 'paint walkable ground',
        gist: 'The mask that decides where anyone can stand.',
        how: [
          'Pick a height under "what you are painting".',
          'Paint over the ground that should carry that height.',
          'Leave everything else unpainted and it is solid.',
        ],
        note:
          'Hand-drawn beats machine-drawn here and it is measured: by hand the boundary sits about 0.7 pixels off, from an automatic pass about 4.2. Your correction is the deliverable.',
      },
      {
        what: 'fill by region',
        gist: 'Flood a whole enclosed area at one height instead of painting it.',
        how: ['Pick "fill by region".', 'Choose the height.', 'Click inside the area.'],
      },
      {
        what: 'heights and terraces',
        gist: 'Different numbers are different levels, so a path can climb.',
        how: [
          'Paint the lower ground one height and the upper ground a higher one.',
          'Paint the ramp between them with the values in between so the step is small enough to climb.',
        ],
        note:
          'How big a step someone can take is stepTolerance. Two heights that differ by more than that are a wall, which is how you fence a terrace without drawing anything solid.',
      },
      {
        what: 'occluder outline',
        gist: 'Marks a thing the player should walk behind.',
        how: [
          'Pick "occluder outline".',
          'Draw round the building or rock.',
          'Set its baseline to the y where its feet meet the ground.',
        ],
        note:
          'The baseline is the whole trick. Above it the player is drawn behind, below it in front, so a wrong baseline reads as someone walking through a wall.',
      },
      {
        what: 'the walkable percentage',
        gist: 'Tells you how much of the map anyone can reach.',
        how: ['Read it under the tools while you paint.'],
      },
    ],
  },
  {
    id: 'test',
    n: 4,
    name: 'test',
    gist: 'Walk the map yourself before it goes anywhere. Nothing here costs anything.',
    items: [
      {
        what: 'walk',
        gist: 'Drops a character on the map and lets you drive.',
        how: ['Press walk.', 'Move with the arrow keys.', 'Press walk again to stop.'],
        note: 'The only honest test of a mask. Somewhere that looks walkable and is not shows up in about five seconds of this.',
      },
      {
        what: 'set start point',
        gist: 'Where the player appears when the map loads.',
        how: ['Press "set start point".', 'Click the spot.'],
      },
      {
        what: 'fix gaps',
        gist: 'Finds the one-pixel holes in the walkable mask and closes them.',
        how: ['Press "fix gaps".'],
        note: 'A hole too small to see will still stop somebody dead, so it is worth pressing even when the mask looks finished.',
      },
      {
        what: 'check reach',
        gist: 'Shows anywhere a player can never get to from the start point.',
        how: ['Set the start point first.', 'Press "check reach".', 'Anything unreachable is marked.'],
      },
      {
        what: 'doors',
        gist: 'A spot that sends the player to another map.',
        how: [
          'Press to add a door and click where it goes.',
          'Give it a name, which is what the player sees.',
          'Type the id of the map it leads to.',
          'Set the radius, which is how close you have to be.',
        ],
      },
    ],
  },
  {
    id: 'assets',
    n: 5,
    name: 'assets',
    gist:
      'Everything that lives on the map. Four things you can make, one library that holds them, and behaviour on anything you place.',
    items: [
      {
        what: 'an asset',
        gist: 'One prop, drawn from a few plain words.',
        how: [
          'Press "an asset".',
          'Type what you want. Three to fifteen words is plenty: "an old wooden hand cart".',
          'Optionally drag a box round the part of the map it will stand in. Esc means no box and is a real answer.',
          'Press "read the map". This is free.',
          'Read what it says it will draw, then press the button with the cost on it.',
        ],
        note:
          'The words you type are not the prompt. The tool reads the painting itself, picks the camera by what your map does with things of that shape, picks the size against things already on the map, and writes the whole prompt. Colours and pixel size are not your job.',
      },
      {
        what: 'a sprite',
        gist: 'A person, an animal, or anything with a body: eight directions and a walk.',
        how: [
          'Press "a sprite".',
          'Type what it is: "a hulking mossy troll with heavy shoulders".',
          'Press "read the map", then confirm the cost.',
        ],
        note:
          'PixelLab has six skeletons and no more. Nothing asks you which one. The tool picks the nearest by body plan, so an upright robot is the humanoid rig and a four-legged dragon is the lion rig, and the prompt carries what it actually is.',
      },
      {
        what: 'another face, on something that already exists',
        gist: 'Gives a thing already in your library a second picture it can change into.',
        how: [
          'Click the thing on the map.',
          'Under its name there are two buttons. Press "becomes", the one with a 1 on it.',
          'Type what it turns into: "curled into a mossy boulder".',
          'Press the button and it draws.',
        ],
        note:
          'This edits the drawing that already exists rather than drawing a second thing, so the face comes back in the same palette at the same size, and on a character every direction is edited together. It belongs to that thing alone, which is why nothing ever asks you which boulder you meant.',
      },
      {
        what: 'motion',
        gist: 'Smoke, water, fire, glow. Drawn by the tool, not generated.',
        how: [
          'Press "motion".',
          'Type what it should look like.',
          'Click the spot on the map so it can read the colours there.',
          'Tune it with the sliders and keep it.',
        ],
        note:
          'Free. About twenty generations of smoke were bought before this existed and none of them worked, because smoke is movement rather than a drawing.',
      },
      {
        what: 'fill an area',
        gist: 'Plans a whole patch of map at once instead of one thing at a time.',
        how: [
          'Press "fill an area" and drag a box.',
          'Type what belongs there.',
          'Read the list it comes back with and cross out anything you do not want.',
          'Start it. Things are drawn one at a time.',
        ],
        note: 'Stop actually stops. Whatever has been drawn already stays, and nothing further is bought.',
      },
      {
        what: 'moves and becomes, the two buttons under a name',
        gist: 'One is behaviour and free. The other draws a picture and costs a generation.',
        how: [
          'Click anything you have placed.',
          '"moves" is free. It asks how the thing behaves: "scuttles about the wet sand, stopping often". Then you drag the box it may roam inside, or press esc to leave it free.',
          '"becomes" costs 1. It draws another picture of that same thing, so it has something to change into.',
        ],
        note:
          'You never need both. Opening one closes the other, and each box says at the top what it is for. A thing that already has the picture it needs only wants "moves". "becomes" turns green once it has one, and its box names what it already wears.',
      },
      {
        what: 'give it a way of moving',
        gist: 'Type how a thing behaves and it moves. Free.',
        how: [
          'Click the thing.',
          'Press "moves" under its name.',
          'Say what it does: "scuttles about the wet sand, stopping often".',
          'Drag the box it may roam inside, or press esc to leave it free.',
        ],
        note:
          'Movement is stored as numbers rather than drawn frames. That is what lets something wander somewhere new each time instead of looping the same little dance, and it is why the preview here and the game agree exactly.',
      },
      {
        what: 'a whole creature in one go',
        gist: 'One sentence for what it is and what it does. One press makes all of it.',
        how: [
          'Go to step 5, assets.',
          'In the four buttons at the top of the right-hand column, press "a sprite".',
          'Under them there is a still / moving pair. Press "moving" if it should walk.',
          'In the box below, type the whole thing: "a big mossy troll that curls into a boulder, rolls around, then gets up and walks again".',
          'Press "read the map". This is free and takes about fifteen seconds.',
          'The card that comes back says the rig it picked, the extra pictures it will draw, and the round it heard. Read it.',
          'Press the button under the card. The number on it counts the body, the walk and every extra picture.',
          'Click the troll in the library, then click the map to put it down. It starts doing what you said.',
        ],
        note:
          'There is no separate place for the transformation. It is the same box as any other sprite, and the second half of the sentence is what turns it into a round. The order it happens in matters, because a round can only name a picture that already exists, and the tool does that for you: bodies, then faces, then the round. If you forget "moving" and the sentence clearly describes walking, the card says so before you spend, but it will not switch it for you, because still costs one generation and moving costs nine.',
      },
      {
        what: 'a thing that changes over time, by hand',
        gist: 'The same result built in pieces, when you want to choose each one.',
        how: [
          'Make its other faces first with "becomes". A round can only name a face that exists.',
          'Press "moves".',
          'Describe the whole round in one go: "walks around, curls into a boulder and holds still, rolls fast across the ground, then unfolds and walks again".',
        ],
        note:
          'Each stage keeps its own clock, so something that freezes for fifteen seconds carries on from where it stopped rather than fifteen seconds further down a walk nobody watched. That is what makes it look like one creature changing instead of two sprites being swapped.',
      },
      {
        what: 'place, move and scale',
        gist: 'Getting things where you want them.',
        how: [
          'Click something in the library, then click the map to put it down.',
          'Drag to move it.',
          'Use the x, y, scale and turn boxes for exact numbers.',
        ],
      },
      {
        what: 'select several at once',
        gist: 'Work on a group instead of one at a time.',
        how: [
          'Drag across empty ground to band-select.',
          'Shift-click to add or drop one.',
          'Ctrl+A takes everything.',
          'Align, space evenly, flip, send to front or back. All of it is one undo.',
        ],
      },
      {
        what: 'match to the map',
        gist: 'Snaps a sprite onto the colours the painting actually uses.',
        how: ['Select it.', `Press "onto the map's own colours".`],
      },
      {
        what: 'ctrl+P, pixelate',
        gist: "Drops something drawn too finely to the map's own pixel size.",
        how: ['Select it and press ctrl+P.'],
        note:
          'The tool works the amount out for you. Anything drawn finer than the map has the exact look of something pasted on top of the painting instead of into it.',
      },
      {
        what: 'ctrl+T, trim the base',
        gist: 'Cuts the slab of invented ground a generator puts under things.',
        how: ['Select it and press ctrl+T.'],
        note:
          'Asking the generator in words not to draw ground does not reliably work. Words are one fence and this is the other.',
      },
      {
        what: 'crop',
        gist: 'Takes a picture in at its edges, the way a slide editor does.',
        how: [
          'Double click the thing on the map.',
          'A black frame opens round the whole picture and everything outside it goes grey.',
          'Drag any of the eight handles inward. Drag from the middle to slide the frame instead.',
          'Press enter to crop, or esc to leave it alone.',
          'z undoes it, art and positions together.',
        ],
        note:
          'It crops the one you picked. If several copies of that thing are on the map there is a tick box under the buttons, off by default, that makes this and the other picture edits change all of them at once. Cropping one on its own gives it a row of its own in the library so the others are left alone.',
      },
      {
        what: 'objects you already own',
        gist: 'Browse the PixelLab account and bring one in. Free.',
        how: ['Press "objects you already own".', 'Search by name.', 'Click one to bring it into this map.'],
        note: 'Hundreds are already sitting there. Nothing here costs a generation, so it is worth looking before you buy.',
      },
      {
        what: 'groups',
        gist: 'Turn whole categories on and off while you work.',
        how: ["Set a thing's group in the panel.", 'Use the eye next to a group to hide or show all of it.'],
      },
      {
        what: 'stop',
        gist: 'Ends anything long that is running.',
        how: ['Press stop.'],
        note: 'What a stop buys is the next generation. Anything already asked for is already paid for and will still land.',
      },
    ],
  },
  {
    id: 'export',
    n: 6,
    name: 'export',
    gist: 'Write the bundle the game loads.',
    items: [
      {
        what: 'export',
        gist: 'Writes the painting, the masks, the map file and every asset into one folder.',
        how: ['Press export.', 'It writes to work/<id>/.'],
        note:
          'Copying that folder into the game is still done by hand today. Open a map with ?scene=pmap&map=<id> once it is there.',
      },
      {
        what: 'save the cut painting only',
        gist: 'Just the png with the sea removed, for when that is all you want.',
        how: ['Press "save the cut painting only".'],
      },
    ],
  },
]

export function Help({ onClose, start }: { onClose: () => void; start?: string }) {
  const [sec, setSec] = useState(start || 'assets')
  const [open, setOpen] = useState<string | null>(null)
  const cur = HELP.find((s) => s.id === sec) || HELP[0]
  return (
    <div className="helpwrap" onClick={onClose}>
      <div className="helppanel" onClick={(e) => e.stopPropagation()}>
        <div className="help-head">
          <span className="help-title">what this tool can do</span>
          <button className="abtn tiny" onClick={onClose}>
            close
          </button>
        </div>
        <div className="help-body">
          <nav className="help-nav">
            {HELP.map((s) => (
              <button
                key={s.id}
                className={'help-sec' + (s.id === sec ? ' on' : '')}
                onClick={() => {
                  setSec(s.id)
                  setOpen(null)
                }}
              >
                <span className="step-n">{s.n}</span>
                {s.name}
              </button>
            ))}
          </nav>
          <div className="help-list">
            <p className="help-gist">{cur.gist}</p>
            {cur.items.map((it) => {
              const on = open === it.what
              return (
                <div key={it.what} className={'help-item' + (on ? ' on' : '')}>
                  <button className="help-row" onClick={() => setOpen(on ? null : it.what)}>
                    <span className="help-what">{it.what}</span>
                    <span className="help-line">{it.gist}</span>
                    <span className="help-caret">{on ? '−' : '+'}</span>
                  </button>
                  {on && (
                    <div className="help-more">
                      <ol>
                        {it.how.map((h, i) => (
                          <li key={i}>{h}</li>
                        ))}
                      </ol>
                      {it.note && <p className="help-note">{it.note}</p>}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
