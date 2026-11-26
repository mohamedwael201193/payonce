// Placeholder landing: renders the CURRENT landing so nothing breaks while
// the v9 landing is built on its own branch. That branch replaces this
// whole folder; the app router only imports { LandingPage } from here.
import { HomePage } from '../pages/HomePage'

export function LandingPage() {
  return <HomePage />
}

export default LandingPage
