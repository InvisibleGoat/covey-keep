import { configure } from '@testing-library/react'

// A limit for a page that never arrives, not for one that is slow. The first render
// in a file can take more than the default 1 s under the suite's own load, and a
// findBy or a waitFor that gives up then fails a test with nothing wrong.
configure({ asyncUtilTimeout: 5_000 })
