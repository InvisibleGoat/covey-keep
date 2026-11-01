import { PRODUCT_NAME } from '../brand'

// The pictures on the screens before the app (CK-81; the design chat's
// mockup, screens 17 to 21): the three matted prints beside sign-in, the
// quail in the lockup and the waiting screens, and the small brand mark —
// and since CK-82 the frame's two: the quail's head beside the product name
// in the top bar and the menu, and the empty cover on the menu's rows.
// Every image here is decorative — `alt=""`, and the prints' frame is
// aria-hidden — so a screen reader hears each screen's words and nothing
// else. The files are served from the app's own origin (public/img/) and
// precached with the app shell (vite.config.ts's globPatterns).
//
// The prints are stock photographs with no people in them (the design
// chat's Unsplash set, chosen and checked for that), so no family's
// photograph is shown to anyone signed out. Each file is the snapshot's
// web layer reduced to the smallest size that covers its largest frame at
// 2× (CK-81's report gives the sizes).

const QUAIL_SRC = '/img/covey-keep-quail-640.webp'
const QUAIL_HEAD_SRC = '/img/covey-keep-quail-head-192.webp'
const PRINTS = ['string-lights', 'lake-dock', 'thanksgiving']

/** Three prints, as if laid on a table: the sign-in screen's art. */
export function SignInPrints() {
  return (
    <div className="auth-art" aria-hidden="true">
      {PRINTS.map((name, index) => (
        <figure key={name} className={`print p${index + 1}`}>
          <img src={`/img/${name}-print.webp`} alt="" />
        </figure>
      ))}
    </div>
  )
}

/** The full quail: in front of the name in the lockup, and breathing on a waiting screen. */
export function Quail() {
  return <img src={QUAIL_SRC} alt="" width={640} height={640} />
}

/** The quail's head alone: the frame's brand, in the top bar and the menu (CK-82). */
export function QuailHead() {
  return <img src={QUAIL_HEAD_SRC} alt="" width={192} height={192} />
}

/**
 * The empty cover, the quail on mint (the mockup's `noimg`): every thumbnail
 * in the menu until covers exist (CK-83, CK-84). Decorative, like the rest.
 */
export function EmptyCover({ className }: { className: string }) {
  return (
    <span className={`noimg ${className}`} aria-hidden="true">
      <img src={QUAIL_SRC} alt="" width={640} height={640} />
    </span>
  )
}

/** The small mark above a screen's heading: the quail's head and the product name. */
export function BrandMark() {
  return (
    <div className="auth-brand">
      <span className="brand-mark">
        <img src={QUAIL_HEAD_SRC} alt="" width={192} height={192} />
        {PRODUCT_NAME}
      </span>
    </div>
  )
}
