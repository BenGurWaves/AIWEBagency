/**
 * VOUTILAINEN | THE CONTINUUM
 * Lenis-Style Finite Inertial Scroll & Magnetic Resonance Interaction
 */

class Atelier {
    constructor() {
        this.loader = document.getElementById('loader');
        this.cursor = document.getElementById('custom-cursor');
        this.hoverTargets = document.querySelectorAll('.hover-target');
        
        this.wrapper = document.getElementById('smooth-wrapper');
        this.content = document.getElementById('smooth-content');
        
        // Scroll State
        this.currentY = 0;
        this.targetY = 0;
        this.ease = 0.08; 
        this.contentHeight = 0;
        this.windowHeight = window.innerHeight;
        
        // Cursor State
        this.mouseX = window.innerWidth / 2;
        this.mouseY = window.innerHeight / 2;
        this.cursorX = this.mouseX;
        this.cursorY = this.mouseY;

        // Interaction Elements
        this.emailBtn = document.getElementById('copy-email-btn');
        this.notification = document.getElementById('copy-notification');
        this.contactTrigger = document.getElementById('contact-trigger');
        this.ripple = document.getElementById('ripple');

        this.init();
    }

    init() {
        // 1. Loader Sequence
        setTimeout(() => {
            this.loader.classList.add('hidden');
            this.calculateHeights();
        }, 3500);

        // 2. Custom Cursor
        window.addEventListener('mousemove', (e) => {
            this.mouseX = e.clientX;
            this.mouseY = e.clientY;
        });

        this.hoverTargets.forEach(target => {
            target.addEventListener('mouseenter', () => this.cursor.classList.add('hovering'));
            target.addEventListener('mouseleave', () => this.cursor.classList.remove('hovering'));
        });

        // 3. Scroll Wheel Interaction
        window.addEventListener('wheel', (e) => {
            e.preventDefault();
            this.targetY += e.deltaY;
            this.targetY = Math.max(0, Math.min(this.targetY, this.contentHeight - this.windowHeight));
        }, { passive: false });
        
        // 4. Resonance Contact Logic
        if (this.contactTrigger && this.ripple && this.emailBtn) {
            this.contactTrigger.addEventListener('click', () => this.triggerResonance());
            this.emailBtn.addEventListener('click', () => this.copyEmail());
        }

        // Handle Resize
        window.addEventListener('resize', () => {
            this.windowHeight = window.innerHeight;
            this.calculateHeights();
        });

        this.render();
    }

    triggerResonance() {
        if (this.ripple.classList.contains('animate')) return;

        // Start Ripple Expansion
        this.ripple.classList.remove('fade');
        this.ripple.classList.add('animate');
        
        // Rotate the jewel bearing for kinetic feedback
        const jewel = this.contactTrigger.querySelector('.jewel-bearing');
        jewel.style.transform = 'scale(2) rotate(180deg)';
        jewel.style.borderColor = '#ffffff';

        // Wait for ripple to expand and 'hit' the email (approx 1000ms based on CSS)
        setTimeout(() => {
            this.copyEmail();
            this.emailBtn.classList.add('pulsing');
            
            // Remove pulse
            setTimeout(() => this.emailBtn.classList.remove('pulsing'), 600);

            // Dissolve the ripple and reset jewel
            setTimeout(() => {
                this.ripple.classList.remove('animate');
                this.ripple.classList.add('fade');
                jewel.style.transform = '';
                jewel.style.borderColor = '';
            }, 800);
            
        }, 1000);
    }

    copyEmail() {
        const email = "voutilainen@voutilainen.ch";
        navigator.clipboard.writeText(email).then(() => {
            this.notification.classList.add('show');
            setTimeout(() => {
                this.notification.classList.remove('show');
            }, 2000);
        });
    }

    calculateHeights() {
        this.contentHeight = this.content.getBoundingClientRect().height;
        this.targetY = Math.max(0, Math.min(this.targetY, this.contentHeight - this.windowHeight));
    }

    lerp(start, end, factor) {
        const next = start + (end - start) * factor;
        return Math.abs(next - end) < 0.01 ? end : next;
    }

    render() {
        this.cursorX = this.lerp(this.cursorX, this.mouseX, 0.15);
        this.cursorY = this.lerp(this.cursorY, this.mouseY, 0.15);
        this.cursor.style.transform = `translate(${this.cursorX}px, ${this.cursorY}px) translate(-50%, -50%)`;

        this.currentY = this.lerp(this.currentY, this.targetY, this.ease);
        this.content.style.transform = `translateY(-${this.currentY}px)`;

        requestAnimationFrame(() => this.render());
    }
}

// Boot
document.addEventListener('DOMContentLoaded', () => {
    new Atelier();
});
