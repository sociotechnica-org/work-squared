# LifeBuild: Open Questions & Uncertainties

> **Living strategic document.** Ranked list of what we don't know yet. Updated as questions get resolved or new ones emerge.

**Snapshot Date:** 2026-02-19  
**Status:** Draft — needs team review and ranking validation

---

## How to Use This Document

1. **Questions are ranked** by (impact × uncertainty). High impact + high uncertainty = top of list.
2. **Each question has a resolution path** — what would answer it?
3. **Resolved questions move to the bottom** with their answer noted.
4. **Review weekly** — reprioritize as we learn.

---

## Active Questions (Ranked)

### 🔴 Critical Uncertainties

**Q1: Does the sanctuary metaphor resonate emotionally?**
- **Impact:** Fatal if wrong — the entire product rests on this
- **Uncertainty:** High — we believe it, but haven't validated with enough users
- **Resolution path:** 20+ onboarding sessions with target users, measure emotional response
- **Signal we're looking for:** Users spontaneously use sanctuary language, describe feeling "at home"

**Q2: Can Jarvis be good enough to feel like a real steward?**
- **Impact:** Fatal if wrong — a mediocre AI advisor is worse than none
- **Uncertainty:** High — prompt engineering vs fine-tuning vs architecture questions
- **Resolution path:** Jarvis quality benchmarking, user perception testing
- **Signal we're looking for:** Users talk TO Jarvis, not ABOUT Jarvis ("I asked Jarvis" not "the AI said")

**Q3: Will users actually return after onboarding?**
- **Impact:** Fatal if wrong — retention is everything
- **Uncertainty:** High — novelty vs habit formation unknown
- **Resolution path:** Ship return experience, measure D7/D30 retention
- **Signal we're looking for:** >40% D7 retention, users mention LifeBuild in daily routine

### 🟡 Important Uncertainties

**Q4: Is "builder context" a real moat or will it be commoditized?**
- **Impact:** High — determines long-term defensibility
- **Uncertainty:** Medium — depends on AI ecosystem evolution
- **Resolution path:** Monitor MCP developments, test context portability scenarios
- **Signal we're looking for:** Users resist exporting context, say "Jarvis knows me"

**Q5: What's our network effect story?**
- **Impact:** High — could be the strongest long-term moat
- **Uncertainty:** High — we haven't designed for this yet
- **Resolution path:** Design spike on network effect mechanics
- **Signal we're looking for:** Feature that gets better with more users

**Q6: Should agents do work or just advise?**
- **Impact:** High — changes the entire product surface
- **Uncertainty:** Medium — technical feasibility clear, user desire unclear
- **Resolution path:** Test "Jarvis did this for you" vs "Jarvis suggests you do this"
- **Signal we're looking for:** Users delegate tasks, not just ask questions

**Q7: What's the right capacity/energy model?**
- **Impact:** Medium — core gameplay loop depends on it
- **Uncertainty:** Medium — Maintain/Invest/Spend is designed but untested
- **Resolution path:** Prototype capacity UI, test with users
- **Signal we're looking for:** Users say "I finally understand where my energy goes"

### 🟢 Open but Lower Priority

**Q8: How do we price this?**
- **Impact:** Medium — affects business model
- **Uncertainty:** Medium — subscription obvious, but what tier structure?
- **Resolution path:** Competitor analysis, willingness-to-pay research
- **Signal we're looking for:** Price point where churn is low and NPS is high

**Q9: What integrations matter most?**
- **Impact:** Medium — affects launch scope
- **Uncertainty:** Low — calendar/email/tasks are obvious
- **Resolution path:** User research on existing tool landscape
- **Signal we're looking for:** "If LifeBuild connected to X, I'd use it daily"

**Q10: How do we handle multi-person households?**
- **Impact:** Medium — affects expansion
- **Uncertainty:** Medium — shared sanctuaries are complex
- **Resolution path:** Design exploration, defer to post-PMF
- **Signal we're looking for:** Couples asking for shared features

---

## Resolved Questions

| Question | Resolution | Date | Notes |
|----------|------------|------|-------|
| D1: Algorithmic hex placement? | Yes — for Release 1 | 2026-02-17 | Builder places later |
| D2: Jarvis UI — route or overlay? | Overlay | 2026-02-17 | Chat panel, not separate page |
| D3: One project per hex? | Yes | 2026-02-17 | Simplicity wins |
| D4: Category room agents? | Deferred | 2026-02-17 | Post-Release 1 |
| D5: Campfire scripted vs improv? | Guided improv | 2026-02-18 | Structure with flexibility |
| D6: Jarvis crisis assessment? | Pattern-based | 2026-02-18 | Three modes: crisis/transition/growth |
| D7: Builder context storage? | LiveStore | 2026-02-17 | Local-first |

---

## Question Intake

When a new uncertainty emerges:
1. Add it to the bottom of Active Questions
2. Estimate impact and uncertainty
3. Define resolution path
4. Review and rank in next weekly sync

---

*This document is the team's uncertainty radar. If we're not updating it, we're not learning.*
