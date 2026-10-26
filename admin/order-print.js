(()=>{
 document.addEventListener('click',event=>{
  if(event.target.closest('[data-print-document], [data-print-button], [data-print-orders=""], #print-order-document'))window.print();
 });
})();
