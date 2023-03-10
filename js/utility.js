/* Set Current Year Copyright */
var today = new Date();
window.document.getElementById('year').innerText = today.getFullYear();

/* Handle Contact Form */
function contact () {
    // Get form data
    var form = document.getElementById("contact-form");
    var data = new FormData(form);

    // Ajax
    var xhr = new XMLHttpRequest();
    xhr.open("POST", "https://api.burrell.tech/contact");

    // What to do when server responds
    xhr.onload = function () {
        var returnCode = this.status // Get return code 
        console.log(returnCode);

        // Send notification
        if (returnCode == 201){
            UIkit.notification({message: '<b><span uk-icon="icon: check""></span> Your message has been sent.</b>', status: 'success', timeout: 0})
            document.getElementById("contact-form").reset(); 
        } else if (returnCode == 429){
            UIkit.notification({message: '<b><span uk-icon="icon: warning"></span> Rate limit exceeded, try later.</b>', status: 'danger', timeout: 10000})
        } else {
            UIkit.notification({message: '<b><span uk-icon="icon: warning"></span> An unknown error occurred.</b>', status: 'danger', timeout: 10000})
        }  
    };
    xhr.send(data); // Send form to API

    // Prevent form from reloading page
    return false;
}
