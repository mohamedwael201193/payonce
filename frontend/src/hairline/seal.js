/**
 * Seal: a round seal stamp over its disc on a plinth. The stamp hovers
 * above the disc; press it and it stamps down on a 700ms ease, the disc
 * takes the bright edge, and the read-out says paid once. Press again to
 * lift it. The slider is the press depth: how far the stamp travels.
 */
const {
  Cam, clamp, circ, facing, fit, hull, open, poly, prism, proj, ringAt, run,
  tdone, tset, tval, tween, disposer, mk, flatDot, place, pointer, put, register, solid, unproj,
} = HL;

// Plinth r=58 (z 0..8), disc r=40 (z 8..11.5), stamp foot r=22 tapering to
// r=13, handle r=7, knob r=10. At rest the stamp foot hovers 12 + depth
// above the ground; pressed, it lands at 12, just over the disc.
const PR = 58, DR = 40, FR = 22, TR = 13, HR = 7, KR = 10;
const PZ0 = 0, PZ1 = 8, DZ0 = 8, DZ1 = 11.5, BODY_H = 16, HANDLE_H = 12, LAND = 12;

function mount({ stage, svg, read }, value) {
  const bag = disposer();
  let depth = value;

  const C = Cam(45, 0.5, 1.6);
  // Fitted with the stamp at its highest (depth 10: foot 22, knob 50).
  fit(C, [[-PR, -PR, 0], [PR, PR, 0], [PR, -PR, 0], [-PR, PR, 0], [0, 0, 50], [-FR, 0, 50], [FR, 0, 50]], 200, 166);
  const P = proj(C), front = facing(C);

  const g = mk("g", {}, svg);
  // Plinth and disc: round solids, bright outside, dim crease inside.
  put(solid(g), prism(P, front, circ(PR, 28), circ(PR - 2, 28), PZ0, PZ1));
  const disc = solid(g);
  put(disc, prism(P, front, circ(DR, 28), circ(DR - 1.5, 28), DZ0, DZ1));
  // The seal's face: one ring on the disc, bright at rest, and three dots.
  const faceRing = mk("path", { d: open(ringAt(P, circ(28, 28), DZ1)), class: "nf hi" }, g);
  const dots = [];
  for (let k = -1; k <= 1; k++) {
    const el = flatDot(g, C, 0.9, k === 0 ? "dot" : "dot m");
    place(el, P(k * 9, 0, DZ1));
    dots.push(el);
  }

  // The stamp: tapered body (two rings, written by hand per rule 09),
  // handle cylinder, knob cap. All three move with one offset.
  const body = solid(g), handle = solid(g);
  const knob = mk("path", { class: "sil" }, g);
  const off = tween(0);
  let drawn = NaN, drawnDepth = NaN;
  function drawStamp() {
    const o = tval(off, performance.now());
    if (o === drawn && depth === drawnDepth) return;
    drawn = o; drawnDepth = depth;
    const z0 = LAND + depth + o, z1 = z0 + BODY_H;
    const foot = circ(FR, 24), top = circ(TR, 24), inner = circ(TR - 1.5, 24);
    put(body, {
      sil: poly(hull(ringAt(P, foot, z0).concat(ringAt(P, top, z1)))),
      crease: open(ringAt(P, run(inner, front), z1)),
    });
    put(handle, prism(P, front, circ(HR, 16), circ(HR - 1, 16), z1, z1 + HANDLE_H));
    knob.setAttribute("d", poly(ringAt(P, circ(KR, 20), z1 + HANDLE_H)));
  }

  const B = register(stage, (dt, now) => {
    drawStamp();
    return !tdone(off, now);
  });
  bag.add(B.unregister);

  let over = false, pressed = false;
  function bright() {
    faceRing.classList.toggle("hi", !over && !pressed);
    body.sil.classList.toggle("hi", over && !pressed);
    disc.sil.classList.toggle("hi", pressed);
    read.textContent = pressed ? "paid once" : over ? "seal" : "rest";
  }
  function setOver(p) {
    const w = p ? unproj(C, p[0], p[1], 0) : null;
    const next = !!w && Math.hypot(w[0], w[1]) < PR + 4;
    if (next === over) return;
    over = next;
    bright();
  }
  function toggle() {
    pressed = !pressed;
    tset(off, pressed ? -depth : 0, performance.now(), 0);
    bright();
    B.wake();
  }

  drawStamp();
  bag.add(pointer(stage, {
    move: (p) => setOver(p),
    down: (p) => { setOver(p); if (over) toggle(); },
    leave: () => { over = false; bright(); },
  }));
  bag.add(() => svg.replaceChildren());

  return {
    set: (v) => {
      depth = v;
      if (!pressed) { drawn = NaN; drawStamp(); B.wake(); }
    },
    destroy: bag.dispose,
  };
}

hairline({
  name: "seal",
  means: "A seal stamp over its disc: press it and it stamps down — one payable, one stamp, one payment.",
  rules: [1, 4, 5, 8, 9, 10],
  range: [2, 6, 10],
  tour: [[134, 141], [245, 181], [200, 110], null],
  mount,
});
