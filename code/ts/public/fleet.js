const status = document.querySelector("#fleet-status");
async function api(path, body) {
  const response = await fetch(
    "/api/fleet/" + path,
    body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {},
  );
  if (response.status === 401) {
    location.replace("/");
    throw Error("Please sign in.");
  }
  const value = await response.json();
  if (!response.ok)
    throw Error(value.error || value.detail || "Fleet search unavailable.");
  return value;
}
function element(tag, text) {
  const e = document.createElement(tag);
  e.textContent = text;
  return e;
}
api("repos")
  .then((repos) => {
    for (const repo of repos) {
      const label = element(
        "label",
        " " +
          repo.repo +
          " · " +
          repo.lines.toLocaleString() +
          " indexed lines",
      );
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = repo.repo;
      input.name = "repo";
      input.checked = true;
      label.prepend(input);
      document
        .querySelector("#fleet-repos")
        .append(label, document.createElement("br"));
    }
    if (!repos.length)
      status.textContent =
        "No fleet repositories are indexed yet. Ask the administrator to bootstrap the manifest.";
  })
  .catch((error) => {
    status.textContent = error.message;
    document.querySelector("#fleet-submit").disabled = true;
  });
document.querySelector("#fleet-form").onsubmit = async (event) => {
  event.preventDefault();
  const repos = [...document.querySelectorAll("input[name=repo]:checked")].map(
    (e) => e.value,
  );
  if (!repos.length) {
    status.textContent = "Select at least one indexed repository.";
    return;
  }
  const button = document.querySelector("#fleet-submit");
  button.disabled = true;
  status.textContent = "Planning searches and checking sources…";
  try {
    const result = await api("ask", {
      question: document.querySelector("#fleet-question").value,
      repos,
    });
    document
      .querySelector("#fleet-answer")
      .replaceChildren(element("h2", "Answer"), element("p", result.answer));
    const sources = document.querySelector("#fleet-sources");
    sources.replaceChildren();
    result.citations.forEach((source, i) => {
      const details = document.createElement("details");
      details.append(
        element(
          "summary",
          `[${i + 1}] ${source.repo}/${source.path}:${source.start_line}–${source.end_line}`,
        ),
      );
      const link = element("a", "View pinned source");
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      details.append(link, element("pre", source.body));
      sources.append(details);
    });
    status.textContent =
      (result.warnings || []).join(" ") ||
      "Sources retrieved. Check citations before relying on the answer.";
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
