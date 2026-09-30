// Acme Notes' own page script: a trial button that counts clicks, so it is easy
// to see that the toolbar's inspect mode stops clicks from reaching the app.
document.addEventListener("DOMContentLoaded", () => {
	const button = document.getElementById("trial");
	const count = document.getElementById("trial-count");
	if (!button || !count) return;
	let trials = 0;
	button.addEventListener("click", () => {
		trials += 1;
		count.textContent = `${trials} ${trials === 1 ? "trial" : "trials"} started from this page.`;
	});
});
