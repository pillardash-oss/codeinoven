package main

import "time"

// The three scripted demo conversations. They exist so the mobile app has
// realistic assistant and user bodies to render: plain text, paragraphs, no
// markup, the way an agent turn actually reads.

// checkoutRetryConversation covers a fix that touches three files.
func checkoutRetryConversation(start time.Time) []seedMessage {
	return []seedMessage{
		{role: "user", at: start.Add(1 * time.Minute), body: "Checkout retries keep firing after a successful payment. " +
			"Reproduce it locally, find the cause, and fix it without changing the retry budget."},
		{role: "assistant", at: start.Add(4 * time.Minute), body: "I reproduced it in the sandbox with the fake payment provider.\n\n" +
			"The retry scheduler keys timers by order id, and the success handler never clears the timer it registered. " +
			"When the timer fires it sees the order as still pending because it reads the pre-update snapshot, so it retries " +
			"a payment that already settled.\n\n" +
			"The fix is to cancel the timer on success and make the retry path re-read the order inside the transaction " +
			"instead of using the snapshot it was created with."},
		{role: "user", at: start.Add(9 * time.Minute), body: "Agreed on both. Do the re-read first so the bug is impossible " +
			"even if a timer escapes, then add the cancellation."},
		{role: "assistant", at: start.Add(21 * time.Minute), body: "Done, in that order.\n\n" +
			"1. `retryOrder` now runs in a transaction and selects the order with `FOR UPDATE` before deciding. A settled " +
			"order returns early and the timer is dropped.\n" +
			"2. The success handler calls `cancelRetry(orderID)` after the commit, so the common path never leaves a timer behind.\n\n" +
			"I also added a regression test that settles an order and then advances the clock past the retry window. It fails " +
			"on the previous code and passes now. Full suite is green."},
		{role: "user", at: start.Add(26 * time.Minute), body: "What happens if the cancel call fails because the process dies " +
			"between commit and cancel?"},
		{role: "assistant", at: start.Add(31 * time.Minute), body: "The timer still fires, but it is now harmless: the retry " +
			"path takes the row lock, sees `status = settled`, and returns without calling the provider. The worst case is one " +
			"wasted wake-up, not a second charge.\n\n" +
			"That is why I did the re-read first. The cancellation is an optimisation for the common case, not the correctness " +
			"boundary."},
		{role: "user", at: start.Add(35 * time.Minute), body: "Good. Summarise the change for the PR description."},
		{role: "assistant", at: start.Add(37 * time.Minute), body: "Summary for the PR:\n\n" +
			"Checkout retries could fire after a successful payment because the retry timer was never cleared and the retry " +
			"path trusted a stale order snapshot. The retry path now re-reads the order under a row lock, so a settled order " +
			"short-circuits. The success handler also cancels its timer. A regression test advances the clock past the retry " +
			"window after settlement.\n\n" +
			"No behaviour change to the retry budget or its backoff."},
	}
}

// sessionRefreshConversation covers an investigation with a rejected approach.
func sessionRefreshConversation(start time.Time) []seedMessage {
	return []seedMessage{
		{role: "user", at: start.Add(2 * time.Minute), body: "After the laptop wakes from sleep the app asks me to sign in " +
			"again even though the session should still be valid. Figure out where the session is being dropped. Do not change " +
			"anything yet."},
		{role: "assistant", at: start.Add(8 * time.Minute), body: "Traced it. Three findings, none of them the token itself:\n\n" +
			"1. The renderer reloads on resume, and the reload races the keychain read. The API client is constructed with an " +
			"empty token and caches that.\n" +
			"2. The client treats a 401 as fatal and clears the stored token, so the race destroys the real credential.\n" +
			"3. The backend is behaving correctly: the session row is alive and `last_used_at` is current.\n\n" +
			"So the session is not being dropped server side. The client throws it away."},
		{role: "user", at: start.Add(12 * time.Minute), body: "That matches what I see in the logs. Could we just retry the " +
			"request once with a token refresh?"},
		{role: "assistant", at: start.Add(14 * time.Minute), body: "No, and I would push back on it. There is nothing to refresh: " +
			"these are opaque sessions, not JWTs, so a retry with the same stale token fails identically and a retry with no " +
			"token fails faster. Retrying would hide the real defect, which is that the token read is not awaited before the " +
			"client is used."},
		{role: "user", at: start.Add(17 * time.Minute), body: "Fair. Then make the read awaited and stop treating 401 as a " +
			"reason to delete the credential."},
		{role: "assistant", at: start.Add(29 * time.Minute), body: "Implemented:\n\n" +
			"The identity bootstrap now awaits the keychain read before any request is issued, and the API client is built from " +
			"that resolved value. A 401 marks the session as unusable and surfaces a sign-in prompt, but it no longer deletes " +
			"the stored token; only an explicit sign-out does.\n\n" +
			"Added a test that constructs the client while the keychain read is still pending and asserts that no request is " +
			"sent until it resolves."},
		{role: "user", at: start.Add(33 * time.Minute), body: "Does the desktop build need the same change?"},
		{role: "assistant", at: start.Add(36 * time.Minute), body: "Yes, but it is a smaller change there. The desktop reads " +
			"the keychain once at startup and never reloads the renderer on resume, so only the 401 deletion bites. I left it " +
			"alone because it is a different process and you asked for this app; it is worth a follow-up so both behave the same."},
		{role: "user", at: start.Add(40 * time.Minute), body: "Note it as a follow-up, then run the tests."},
		{role: "assistant", at: start.Add(44 * time.Minute), body: "Follow-up noted. Tests: the new resume test passes, the " +
			"existing identity tests pass, and the lint and type checks are clean. No other files touched."},
	}
}

// presenceConversation covers a design discussion that ends in a plan.
func presenceConversation(start time.Time) []seedMessage {
	return []seedMessage{
		{role: "user", at: start.Add(1 * time.Minute), body: "The mobile app shows a thread as runnable on this phone even " +
			"when it belongs to the laptop. I want it to say where the work runs and whether that machine is awake. Keep it " +
			"simple."},
		{role: "assistant", at: start.Add(6 * time.Minute), body: "Simplest honest version: the backend already stores an Oven " +
			"row per machine with `last_heartbeat_at`. Treat it as online when the heartbeat is under two minutes old, offline " +
			"otherwise, and show the machine's name next to it.\n\n" +
			"Nothing about a thread has to move. The thread keeps its `ovenId`, and the client joins that to the Oven list it " +
			"already fetches."},
		{role: "user", at: start.Add(10 * time.Minute), body: "What if the laptop is asleep for eight hours and I open the app?"},
		{role: "assistant", at: start.Add(13 * time.Minute), body: "The list comes back with the Oven present and stale, so the " +
			"message reads \"this Oven is on your laptop and it is offline\". That is a true statement and it is the one that " +
			"stops a user waiting for a run that cannot start.\n\n" +
			"I would not hide offline Ovens. Hiding them makes the thread look orphaned."},
		{role: "user", at: start.Add(16 * time.Minute), body: "Do it. Server support is already there?"},
		{role: "assistant", at: start.Add(22 * time.Minute), body: "Yes. `POST /v1/ovens/heartbeat` upserts on the machine " +
			"fingerprint and `GET /v1/ovens` returns `lastHeartbeatAt` in epoch milliseconds. Both are implemented in this " +
			"backend and covered by the client types.\n\n" +
			"The plan:\n" +
			"1. Fetch Ovens alongside the thread list on refresh.\n" +
			"2. Derive online state from `lastHeartbeatAt` with a two minute window.\n" +
			"3. Show the machine name and state on the thread header, and block the send button when the owning Oven is offline.\n" +
			"4. Keep the last known state visible while offline instead of an empty header."},
		{role: "user", at: start.Add(25 * time.Minute), body: "Blocking send is right. What about a queued prompt that was " +
			"already accepted before the Oven went to sleep?"},
		{role: "assistant", at: start.Add(28 * time.Minute), body: "The prompt stays queued. The server accepted it and the " +
			"Oven picks it up when it comes back, so the client should show \"queued, waiting for this Oven\" rather than a " +
			"failure. Retrying the send would create a duplicate, which is what `clientId` on the prompt endpoint exists to " +
			"prevent.\n\n" +
			"I will fold that state into the same header work so the wording is consistent."},
	}
}
