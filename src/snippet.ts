/**
 * HTML for a payment-link button. Paste it into any page or template.
 * The script posts the link id to the plugin and follows the returned
 * Zarinpal URL; it only ever navigates to a zarinpal.com gateway address.
 */
export function buttonSnippet(pluginId: string, linkId: string, label: string): string {
	return `<form class="zarinpal-pay" data-link="${linkId}" data-endpoint="/_emdash/api/plugins/${pluginId}/pay">
  <!-- Optional, sent to Zarinpal: <input name="email" type="email"> <input name="mobile" placeholder="09xxxxxxxxx"> -->
  <button type="submit">${label}</button>
</form>
<script>
(() => {
  if (window.__zarinpalPay) return;
  window.__zarinpalPay = true;
  document.addEventListener("submit", async (event) => {
    const form = event.target.closest && event.target.closest("form.zarinpal-pay");
    if (!form) return;
    event.preventDefault();
    const button = form.querySelector("button");
    if (button) button.disabled = true;
    const fields = new FormData(form);
    try {
      const res = await fetch(form.dataset.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          link: form.dataset.link,
          email: fields.get("email") || undefined,
          mobile: fields.get("mobile") || undefined,
        }),
      });
      const out = (await res.json()).data;
      if (out && out.ok && /^https:\\/\\/(payment|sandbox)\\.zarinpal\\.com\\//.test(out.paymentUrl)) {
        location.href = out.paymentUrl;
        return;
      }
      alert("Payment could not start: " + ((out && out.error) || res.status));
    } catch (error) {
      alert("Payment could not start. Please try again.");
    }
    if (button) button.disabled = false;
  });
})();
</script>`;
}
