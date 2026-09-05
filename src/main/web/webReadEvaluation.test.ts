import { describe, expect, it, vi } from 'vitest'
import { readWebUrl, type WebPageRenderer } from './readWebUrl.js'

interface EvaluationSite {
  id: string
  category: 'public' | 'consent' | 'login' | 'loading' | 'captcha' | 'security' | 'site-error'
  url: string
  title: string
  html: string
  expectedSnippet: string
}

function rendererReturning(html: string, title: string): WebPageRenderer {
  return vi.fn(async ({ url }) => ({
    requestedUrl: url,
    finalUrl: `${url}#capture`,
    title,
    html,
  }))
}

function headFallbackFetch() {
  return vi.fn(async () => ({
    ok: false,
    status: 405,
    headers: new Headers({}),
    text: async () => '',
    arrayBuffer: async () => new ArrayBuffer(0),
  }))
}

function articleHtml(title: string, body: string): string {
  return `<main><article><h1>${title}</h1><p>${body}</p><table><tr><th>Signal</th><th>Value</th></tr><tr><td>Coverage</td><td>Readable</td></tr></table></article></main>`
}

function site(
  id: string,
  category: EvaluationSite['category'],
  url: string,
  title: string,
  body: string,
): EvaluationSite {
  return {
    id,
    category,
    url,
    title,
    html: category === 'public' ? articleHtml(title, body) : `<main><h1>${title}</h1><p>${body}</p></main>`,
    expectedSnippet: body,
  }
}

const EVALUATION_SITES: EvaluationSite[] = [
  site('wikipedia', 'public', 'https://en.wikipedia.org/wiki/Berlin', 'Berlin', 'Population history and transport links.'),
  site('mdn', 'public', 'https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API', 'Fetch API', 'Fetch provides an interface for fetching resources.'),
  site('github-docs', 'public', 'https://docs.github.com/en/actions', 'GitHub Actions', 'Automate build, test, and deployment workflows.'),
  site('nodejs', 'public', 'https://nodejs.org/api/fs.html', 'File system', 'The node file system module exposes callback and promise APIs.'),
  site('npm', 'public', 'https://www.npmjs.com/package/vitest', 'vitest', 'A fast unit testing framework powered by Vite.'),
  site('pypi', 'public', 'https://pypi.org/project/pdfminer.six/', 'pdfminer.six', 'Community maintained tool for extracting information from PDF documents.'),
  site('arxiv', 'public', 'https://arxiv.org/abs/2401.00001', 'Research abstract', 'We introduce a benchmark for long-context retrieval.'),
  site('pubmed', 'public', 'https://pubmed.ncbi.nlm.nih.gov/12345678/', 'PubMed record', 'The abstract describes methods, results, and conclusions.'),
  site('clinicaltrials', 'public', 'https://clinicaltrials.gov/study/NCT00000000', 'Clinical study', 'Enrollment, interventions, and primary outcome measures are listed.'),
  site('who', 'public', 'https://www.who.int/news-room/fact-sheets/detail/influenza-(seasonal)', 'Seasonal influenza', 'Symptoms include fever, cough, headache, muscle and joint pain.'),
  site('govuk', 'public', 'https://www.gov.uk/guidance/driving-in-the-eu', 'Driving in the EU', 'Check documents and insurance before travelling.'),
  site('eu', 'public', 'https://ec.europa.eu/commission/presscorner/detail/en/ip_26_001', 'Commission press corner', 'The Commission adopted a proposal and published supporting materials.'),
  site('berlin-service', 'public', 'https://service.berlin.de/dienstleistung/120686/', 'Registration certificate', 'Appointments, documents, and fees are shown for the service.'),
  site('bahnhof', 'public', 'https://www.bahnhof.de/berlin-ostkreuz/abfahrt', 'Berlin Ostkreuz departures', 'RB24 departures include Eberswalde and Senftenberg services.'),
  site('regio-nordost', 'public', 'https://regio-nordost.de/aktuelle-meldungen/', 'DB Regio Nordost disruptions', 'Current traffic reports list route, period, and replacement service.'),
  site('openstreetmap', 'public', 'https://wiki.openstreetmap.org/wiki/Key:railway', 'OpenStreetMap railway key', 'Railway tagging describes stations, platforms, and tracks.'),
  site('hacker-news', 'public', 'https://news.ycombinator.com/item?id=1', 'Discussion thread', 'Comments are grouped by score, age, and nesting.'),
  site('apnews', 'public', 'https://apnews.com/article/example', 'AP News article', 'The report includes dateline, summary, and source attribution.'),
  site('nature', 'public', 'https://www.nature.com/articles/example', 'Nature article', 'The abstract summarizes experimental design and findings.'),
  site('vercel', 'public', 'https://vercel.com/docs/functions', 'Vercel Functions', 'Functions run server-side code close to users.'),
  site('stripe-docs', 'public', 'https://docs.stripe.com/payments', 'Stripe payments', 'PaymentIntents track the lifecycle of a customer payment.'),
  site('react', 'public', 'https://react.dev/reference/react/useMemo', 'useMemo', 'Cache a calculation between re-renders.'),
  site('vue', 'public', 'https://vuejs.org/guide/introduction.html', 'Vue introduction', 'Components combine declarative templates with reactive state.'),
  site('typescript', 'public', 'https://www.typescriptlang.org/docs/handbook/2/everyday-types.html', 'Everyday Types', 'Type annotations describe primitives, arrays, and object shapes.'),
  site('sqlite', 'public', 'https://sqlite.org/lang_select.html', 'SELECT statement', 'A SELECT statement reads data from one or more tables.'),
  site('google-search-consent', 'consent', 'https://www.google.com/search?q=rail+delays', 'Before you continue to Google', 'We value your privacy and ask you to review options.'),
  site('youtube-consent', 'consent', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'Before you continue', 'We value your privacy on this service.'),
  site('reuters-consent', 'consent', 'https://www.reuters.com/world/', 'Privacy choices', 'We value your privacy and offer privacy choices.'),
  site('guardian-consent', 'consent', 'https://www.theguardian.com/world', 'Privacy choices', 'Review privacy choices before continuing.'),
  site('spiegel-consent', 'consent', 'https://www.spiegel.de/international/', 'Cookie settings', 'Please accept cookies to continue.'),
  site('booking-consent', 'consent', 'https://www.booking.com/city/de/berlin.html', 'Cookie consent', 'Cookie consent is required before the page can be shown.'),
  site('tripadvisor-consent', 'consent', 'https://www.tripadvisor.com/Restaurants-g187323-Berlin.html', 'Privacy choices', 'Choose privacy choices for personalized content.'),
  site('airbnb-consent', 'consent', 'https://www.airbnb.com/s/Berlin/homes', 'Cookie preferences', 'Accept cookies to continue browsing stays.'),
  site('linkedin-login', 'login', 'https://www.linkedin.com/in/example/', 'Sign in', 'Log in to continue to the profile.'),
  site('x-login', 'login', 'https://x.com/example', 'Sign in', 'Log in to continue.'),
  site('facebook-login', 'login', 'https://www.facebook.com/example', 'Log in', 'Please log in to continue.'),
  site('instagram-login', 'login', 'https://www.instagram.com/example/', 'Login', 'Login to continue viewing photos and videos.'),
  site('researchgate-login', 'login', 'https://www.researchgate.net/publication/example', 'Sign in', 'Please sign in to read the publication.'),
  site('ft-login', 'login', 'https://www.ft.com/content/example', 'Sign in', 'Sign in to continue reading.'),
  site('linear-loading', 'loading', 'https://linear.app/acme/team/SHO/active', 'Linear', 'Loading...'),
  site('stackoverflow-security', 'security', 'https://stackoverflow.com/questions/1', 'Just a moment...', 'Performing security verification before loading the question.'),
  site('reddit-captcha', 'captcha', 'https://www.reddit.com/r/programming/comments/example', 'Are you a robot?', 'Complete the captcha before continuing.'),
  site('ticketmaster-security', 'security', 'https://www.ticketmaster.com/event/example', 'Verify you are human', 'Security verification is required for this event page.'),
  site('cloudflare-security', 'security', 'https://challenge.cloudflare.com/example', 'Checking your browser', 'Checking your browser before accessing the site.'),
  site('yelp-captcha', 'captcha', 'https://www.yelp.com/biz/example', 'Human check', 'hCaptcha is required before the listing can be shown.'),
  site('sec-access-denied', 'site-error', 'https://www.sec.gov/ixviewer/doc/action', 'Access denied', 'Access denied while requesting the filing.'),
  site('maps-consent', 'consent', 'https://maps.google.com/search/coffee+ostkreuz', 'Before you continue to Google Maps', 'We value your privacy.'),
  site('slack-login', 'login', 'https://app.slack.com/client/T123/C456', 'Sign in', 'Log in to continue to Slack.'),
  site('notion-login', 'login', 'https://www.notion.so/workspace/research-notes', 'Sign in', 'Please sign in to continue.'),
  site('docs-google-login', 'login', 'https://docs.google.com/document/d/example/edit', 'Sign in', 'Sign in to continue to Google Docs.'),
]

describe('web reading evaluation set', () => {
  it('covers 50 representative websites with distinct hosts and page shapes', () => {
    expect(EVALUATION_SITES).toHaveLength(50)
    expect(new Set(EVALUATION_SITES.map(candidate => new URL(candidate.url).hostname)).size).toBe(50)
    expect(new Set(EVALUATION_SITES.map(candidate => candidate.category))).toEqual(new Set([
      'public',
      'consent',
      'login',
      'loading',
      'captcha',
      'security',
      'site-error',
    ]))
  })

  it('returns captured content without classifier verdicts across the full set', async () => {
    for (const candidate of EVALUATION_SITES) {
      const result = await readWebUrl({
        url: candidate.url,
        max_chars: 100_000,
      }, {
        fetch: headFallbackFetch(),
        renderRendered: rendererReturning(candidate.html, candidate.title),
        now: () => 1_000,
      })

      expect(result.source, candidate.id).toBe('rendered')
      expect(result.final_url, candidate.id).toBe(`${candidate.url}#capture`)
      expect(result.content, candidate.id).toContain(candidate.expectedSnippet)
      expect(result, candidate.id).not.toHaveProperty('status')
      expect(result, candidate.id).not.toHaveProperty('attention_required')
    }
  })
})
