// Basic pricing calculation designed by the basic pricing group.

// Price per hour for each pricing level.
const small = 1;
const medium = 3;
const large = 5;


// Calculate the total parking price.
function calculatePrice(hours) {
    let totalPrice = 0;

    // Use the small rate for 1 to 2 hours.
    if (hours <= 2) {
        totalPrice = hours * small;

    // Use the medium rate for 3 to 5 hours.
    } else if (hours <= 5) {
        totalPrice = hours * medium;

    // Use the large rate for more than 5 hours.
    } else {
        totalPrice = hours * large;
    }

    return totalPrice;
}


// Read the parking time and show the result.
function showPrice() {
    // Get the input box and result box.
    const hoursInput = document.getElementById("hours");
    const priceBox = document.getElementById("priceBox");

    // Change the user input into a number.
    const hours = Number(hoursInput.value);

    // Check if the parking time is valid.
    if (hoursInput.value === "" || hours < 0) {
        priceBox.textContent = "Please enter a valid parking time.";
        priceBox.style.display = "block";
        return;
    }

    // Calculate the parking price.
    const totalPrice = calculatePrice(hours);

    // Show the final price.
    priceBox.textContent =
        `Total Price: $${totalPrice.toFixed(2)}`;

    priceBox.style.display = "block";
}


// Run showPrice when the Calculate button is clicked.
document
    .getElementById("calc-btn")
    .addEventListener("click", showPrice);