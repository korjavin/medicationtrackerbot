class MTCard extends HTMLElement {
    connectedCallback() {
        if (!this.hasAttribute('role')) this.setAttribute('role', 'article');
    }
}
window.MTCard = MTCard;
