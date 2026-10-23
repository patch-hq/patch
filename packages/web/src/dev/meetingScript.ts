// A scripted call for the dev harness only (`?meeting=demo`): plays into the
// meeting panel a line at a time so the feed, Just said and the transcript can
// be watched without a call, a microphone or a host. Never shipped: the harness
// is not part of the production build.

export interface DemoLine {
  speaker: 'you' | 'them';
  name?: string;
  text: string;
}

export const DEMO_SCRIPT: readonly DemoLine[] = [
  {
    speaker: 'you',
    text: 'Morning both. Shall we start with how the quarter went, then get to pricing?',
  },
  {
    speaker: 'them',
    name: 'Priya',
    text: 'Sure. Revenue was up eleven percent on last quarter, mostly from the Team plan.',
  },
  {
    speaker: 'them',
    name: 'Sam',
    text: 'Team plan upgrades nearly doubled after we added the shared workspace.',
  },
  {
    speaker: 'them',
    name: 'Priya',
    text: 'The worrying bit is the Starter plan. Monthly churn went from about three percent in June to just over four now.',
  },
  {
    speaker: 'you',
    text: 'Is that new customers leaving, or people who have been with us a while?',
  },
  {
    speaker: 'them',
    name: 'Priya',
    text: 'Mostly people in their second month. They try it, pay once, then go.',
  },
  {
    speaker: 'them',
    name: 'Sam',
    text: 'And Acme dropped their entry price to nine pounds a month in September, which will not help.',
  },
  {
    speaker: 'you',
    text: 'So the question for today is whether we cut the Starter price to match, or do something else.',
  },
  {
    speaker: 'them',
    name: 'Sam',
    text: "I'm against cutting. It trains people to wait for a discount and it's hard to undo.",
  },
  {
    speaker: 'them',
    name: 'Priya',
    text: 'Cutting to nine pounds would cost us roughly forty thousand a year at current volume.',
  },
  {
    speaker: 'you',
    text: 'What about an annual plan with a discount? Lock people in past that second month.',
  },
  {
    speaker: 'them',
    name: 'Priya',
    text: 'We already have one, but it is buried in settings. Only about eight percent of Starter customers have even seen it.',
  },
  {
    speaker: 'them',
    name: 'Sam',
    text: 'Then the cheap win is putting annual on the pricing page and in the upgrade prompt.',
  },
  {
    speaker: 'you',
    text: "Agreed. So we're not cutting the Starter price this quarter. Everyone happy with that?",
  },
  { speaker: 'them', name: 'Sam', text: 'Yes.' },
  { speaker: 'them', name: 'Priya', text: 'Yes, as long as we push annual properly.' },
  { speaker: 'you', text: 'How big should the annual discount be? Fifteen or twenty percent?' },
  {
    speaker: 'them',
    name: 'Priya',
    text: "I'd want to model both before we pick. I need the churn cohort by signup month for that.",
  },
  { speaker: 'them', name: 'Sam', text: 'I can pull the cohort data. Friday should be fine.' },
  {
    speaker: 'them',
    name: 'Priya',
    text: 'One thing: does Stripe prorate if someone switches to annual halfway through a month? That changes the maths.',
  },
  { speaker: 'you', text: "Good question, I don't know. Someone should check." },
  {
    speaker: 'them',
    name: 'Sam',
    text: 'We should also email Starter customers in their first month about the annual option.',
  },
  { speaker: 'you', text: "Let's get a draft of that email so we can look at it next week." },
  {
    speaker: 'them',
    name: 'Priya',
    text: 'Can we meet again next Thursday once the numbers are in?',
  },
  { speaker: 'you', text: "Yes. I'll send an invite. Thanks both." },
];
